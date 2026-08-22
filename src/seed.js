"use strict";
/**
 * 双星系统：会话种子提取器（C 层代班的基础）。
 * 读取主星最近会话的 session.jsonl.zstd（多帧 zstd 拼接），解压后提取最近 N 条
 * 用户/助手消息文本，写成 seed/latest.txt + meta.json，供代班智能体续接对话。
 *
 * 只读主星会话存储，绝不修改。
 */
const fs = require("node:fs");
const path = require("node:path");
const { zstdDecompressSync } = require("node:zlib");

/**
 * 按持久化后端的权威实现（dsh-session-persistence-jsonl/lib/zstd.js）切分帧。
 * 要点：checksum 标志 = descriptor bit 2；dictionary 字段；尾部撕裂帧优雅停止。
 */
function splitZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) break; // 撕裂尾部
    if (buf.readUInt32LE(offset) !== 0xfd2fb528) {
      throw new Error(`zstd 帧切分: ${offset} 处 magic 非法`);
    }
    offset += 4;
    if (offset === buf.length) break;
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`zstd 帧切分: ${offset - 1} 处保留头位`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return frames; // 撕裂
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`zstd 帧切分: ${offset - 3} 处保留块类型`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 解压整个会话文件（多帧拼接）为 JSONL 行数组 */
function decompressSession(file) {
  const buf = fs.readFileSync(file);
  const frames = splitZstdFrames(buf);
  const chunks = [];
  for (const f of frames) {
    const out = zstdDecompressSync(buf.subarray(f.start, f.end));
    chunks.push(out);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 找工作区最新会话目录（支持直接含 session-* 的根，或含 workspace 子目录的根） */
function latestSessionDir(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return null;
  const dirs = fs.readdirSync(sessionsRoot)
    .map((n) => path.join(sessionsRoot, n))
    .filter((p) => fs.statSync(p).isDirectory());
  const direct = dirs.filter((p) => /^session-/.test(path.basename(p)));
  const pool = direct.length ? direct : dirs;
  if (!pool.length) return null;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pool[0];
}

/**
 * 提取最近 N 条对话消息（识别 user/message 与 assistant/message 记录；
 * 跳过流式 chunk/tool 等中间产物）。
 */
function extractMessages(lines, n) {
  const out = [];
  for (const o of lines) {
    if (!o || typeof o !== "object") continue;
    if (o.type !== "user/message" && o.type !== "assistant/message") continue;
    const role = o.type === "user/message" ? "user" : "assistant";
    const d = o.data || {};
    let text = null;
    if (typeof d.text === "string") text = d.text;
    else if (Array.isArray(d.content)) {
      text = d.content
        .map((c) => (typeof c === "string" ? c : c && c.text != null ? String(c.text) : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (text !== null && text.trim()) out.push({ role, text: text.trim() });
  }
  return out.slice(-n);
}

/**
 * 提取种子并写文件。
 * @param sessionsRoot 主星工作区会话根（如 <DSH_HOME>/sessions/--D-DSH--）
 * @param stateDir     双星状态目录（seed/ 写到这里）
 * @param n            最近 N 条消息
 */
function writeSeed(sessionsRoot, stateDir, n = 40) {
  const dir = latestSessionDir(sessionsRoot);
  if (!dir) return { ok: false, reason: "无会话目录" };
  const file = path.join(dir, "session.jsonl.zstd");
  if (!fs.existsSync(file)) return { ok: false, reason: "无 session.jsonl.zstd" };
  const lines = decompressSession(file);
  const header = lines.find((o) => o.type === "session");
  const messages = extractMessages(lines, n);
  const seedDir = path.join(stateDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  const text = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text}`)
    .join("\n\n");
  const meta = {
    ts: new Date().toISOString(),
    sessionId: header && header.id,
    createdAt: header && header.createdAt,
    cwd: header && header.cwd,
    agentPreset: header && header.agentPreset,
    totalLines: lines.length,
    messageCount: messages.length,
    lastN: n,
    source: file,
  };
  fs.writeFileSync(path.join(seedDir, "latest.txt"), `# 会话种子（${meta.sessionId || "?"}，取最近 ${n} 条）\n\n${text || "(无可提取消息)"}\n`);
  fs.writeFileSync(path.join(seedDir, "latest.meta.json"), JSON.stringify(meta, null, 2));
  return { ok: true, meta, text };
}

module.exports = { splitZstdFrames, decompressSession, latestSessionDir, extractMessages, writeSeed };
