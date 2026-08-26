"use strict";
/**
 * 会话修复工具（dsh-binary session-repair）：
 * 修复"API 400: assistant tool_calls 缺少对应 tool 消息"导致的会话卡死。
 *
 * 背景：dsh 的组装层把流式 tool-call-chunks 组装成 assistant 消息的 tool_calls。
 * 当一次模型流被中断（主星重启/网络中断）时，chunks 已持久化但对应的
 * tool/call + tool/result 记录未写入 → 组装出的历史含"孤儿 tool_calls" →
 * DeepSeek API 每次请求都 400 → 会话表现为"发任何消息都立刻失败"。
 * dsh 官方 repair（dsh-session/repair）只扫描 assistant/message 内的块，
 * 不覆盖 chunks 组装出的孤儿 —— 本工具用"删除 error turn"的方式手术修复。
 *
 * 用法:
 *   node scripts/session-repair.js <会话目录> [--dry-run] [--all-error-turns] [--turn N]
 *   默认只删除最后一个 error turn；--all-error-turns 删除全部；--turn N 指定单个。
 *   执行前自动备份会话文件为 session.jsonl.zstd.bak-<ts>。
 *   修复后需由外部重启主星（清会话缓存）再在 GUI 中测试。
 */
const fs = require("node:fs");
const path = require("node:path");
const { zstdCompressSync, zstdDecompressSync, constants: zstdConstants } = require("node:zlib");

const sessionDir = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const allErrorTurns = process.argv.includes("--all-error-turns");
// --turn N（可重复）显式指定要删除的 error turn 号
const turnArgs = [];
process.argv.forEach((a, i) => { if (a === "--turn" && process.argv[i + 1]) turnArgs.push(Number(process.argv[i + 1])); });

if (!sessionDir) {
  console.error("用法: node scripts/session-repair.js <会话目录> [--dry-run] [--all-error-turns] [--turn N]");
  process.exit(2);
}

// 复用自己的 zstd 帧切分（与 seed.js 同源，但避免引入依赖）
function splitZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) break;
    if (buf.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`zstd magic 非法 @${offset}`);
    offset += 4;
    if (offset === buf.length) break;
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("zstd 保留头位");
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
      if (buf.length - offset < 3) return frames;
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("zstd 保留块类型");
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

const file = path.join(sessionDir, "session.jsonl.zstd");
if (!fs.existsSync(file)) { console.error(`会话文件不存在: ${file}`); process.exit(1); }
const buf = fs.readFileSync(file);
const frames = splitZstdFrames(buf);
const text = Buffer.concat(frames.map((f) => require("node:zlib").zstdDecompressSync(buf.subarray(f.start, f.end)))).toString("utf8");
const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`会话: ${path.basename(sessionDir)} | 记录 ${lines.length} 条`);

// 找出 error turn 的序号与范围
const errorTurns = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const o = lines[i];
  if (o.type === "turn/start") cur = { no: o.data && o.data.turn, start: i };
  if (o.type === "turn/end" && cur && o.data && o.data.turn === cur.no) {
    const reason = o.data.reason && o.data.reason.kind;
    if (reason === "error") errorTurns.push({ no: cur.no, start: cur.start, end: i });
    cur = null;
  }
}
console.log(`error turn: ${errorTurns.length ? errorTurns.map((t) => `#${t.no}(记录 ${t.start}-${t.end})`).join(", ") : "无"}`);
if (errorTurns.length === 0) { console.log("无需修复（没有 error turn）"); process.exit(0); }

let targets;
if (turnArgs.length) {
  targets = errorTurns.filter((t) => turnArgs.includes(t.no));
  if (targets.length !== turnArgs.length) {
    const missing = turnArgs.filter((n) => !errorTurns.some((t) => t.no === n));
    console.error(`[!] 以下 turn 不是 error turn（或不存在）: ${missing.join(", ")}（error turns: ${errorTurns.map((t) => t.no).join(", ")}）`);
    process.exit(1);
  }
} else {
  targets = allErrorTurns ? errorTurns : [errorTurns[errorTurns.length - 1]];
}
const ranges = targets.map((t) => [t.start, t.end]);
const kept = lines.filter((_, i) => !ranges.some(([s, e]) => i >= s && i <= e));
console.log(`将删除 ${targets.length} 个 error turn（记录 ${targets.reduce((a, t) => a + (t.end - t.start + 1), 0)} 条），剩余 ${kept.length} 条`);

if (dryRun) { console.log("[dry-run] 未写入。"); process.exit(0); }

// 备份
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(file, backup);
console.log(`备份: ${backup}`);

// ⚠️ 重写必须遵守 dsh 会话格式契约（2026-08-26 事故教训）：
//   每条记录 = 一个独立的 zstd 帧（每帧内容为一行 JSON + "\n"），
//   且每帧带 checksum 标志（与 dsh-session-persistence-jsonl 的
//   compressZstdFrame 一致：ZSTD_c_checksumFlag=1）。
//   单帧压缩整个 JSONL 会导致 dsh-workspace 启动时首帧校验失败：
//   "corrupt Zstandard session log: first frame is not exactly one header line"
function compressLine(line) {
  return zstdCompressSync(Buffer.from(line + "\n", "utf8"), {
    params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 },
  });
}
const outBuf = Buffer.concat(kept.map((o) => compressLine(JSON.stringify(o))));

// 自校验（不通过则不落盘）：帧数 = 行数；首帧解压 = 恰好一行（header 校验语义）
{
  const frames = [];
  let off = 0;
  while (off < outBuf.length) {
    if (outBuf.length - off < 4 || outBuf.readUInt32LE(off) !== 0xfd2fb528) break;
    const s = off;
    off += 4;
    const d = outBuf.readUInt8(off);
    off += 1;
    const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df, csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (outBuf.length - off < rhb) break;
    off += rhb;
    for (;;) {
      if (outBuf.length - off < 3) break;
      const bh = outBuf.readUIntLE(off, 3);
      off += 3;
      const lb = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) break;
      const pb = bt === 1 ? 1 : bs;
      if (outBuf.length - off < pb) break;
      off += pb;
      if (lb) break;
    }
    if (chk) { if (outBuf.length - off < 4) break; off += 4; }
    frames.push([s, off]);
  }
  if (frames.length !== kept.length) {
    console.error(`[!] 自校验失败：帧数 ${frames.length} != 行数 ${kept.length}，未落盘（保留备份可恢复）`);
    process.exit(1);
  }
  const first = zstdDecompressSync(outBuf.subarray(frames[0][0], frames[0][1])).toString("utf8");
  const firstLines = first.split("\n").filter(Boolean);
  if (firstLines.length !== 1) {
    console.error(`[!] 自校验失败：首帧解压为 ${firstLines.length} 行（必须恰好 1 行 header），未落盘`);
    process.exit(1);
  }
  console.log(`[ok] 自校验通过：${frames.length} 帧 = ${kept.length} 行，首帧为单行 header`);
}

fs.writeFileSync(file, outBuf);
console.log(`已重写（删除 ${lines.length - kept.length} 条记录）。`);
console.log("下一步：由外部重启主星清会话缓存后，在 GUI 会话中发消息测试。");
console.log("恢复：copy 备份文件覆盖 session.jsonl.zstd 并重启主星。");
