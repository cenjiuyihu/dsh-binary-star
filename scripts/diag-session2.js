"use strict";
/**
 * P3 探索 2：createZstdDecompress 流式解压拼接帧（只读）。
 * 自动定位 dsh 会话根下最近有内容的工作区目录，无需硬编码路径。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createZstdDecompress } = require("node:zlib");

const SESSIONS_ROOT = process.env.DSH_SESSIONS || path.join(os.homedir(), ".dsh", "sessions");

function latestWorkspaceDir() {
  if (!fs.existsSync(SESSIONS_ROOT)) return null;
  const dirs = fs.readdirSync(SESSIONS_ROOT)
    .map((n) => path.join(SESSIONS_ROOT, n))
    .filter((p) => fs.statSync(p).isDirectory());
  if (!dirs.length) return null;
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

const workspace = latestWorkspaceDir();
if (!workspace) { console.error("找不到会话目录（DSH_SESSIONS 可覆盖）"); process.exit(1); }
const target = process.argv[2] || fs.readdirSync(workspace).sort((a, b) =>
  fs.statSync(path.join(workspace, b)).mtimeMs - fs.statSync(path.join(workspace, a)).mtimeMs)[0];
const file = path.join(workspace, target, "session.jsonl.zstd");
const buf = fs.readFileSync(file);

const dec = createZstdDecompress();
const chunks = [];
dec.on("data", (c) => chunks.push(c));
dec.on("error", (e) => { console.error("DECODE ERROR:", e.message); process.exit(1); });
dec.on("end", () => {
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  console.log("session:", target, "| lines:", lines.length);
  const types = {};
  for (const l of lines) {
    try { const o = JSON.parse(l); types[o.type] = (types[o.type] || 0) + 1; } catch {}
  }
  console.log("type counts:", JSON.stringify(types));
  // 打印一条消息类记录的结构
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.type !== "session") { console.log("record keys:", Object.keys(o).join(",")); console.log("sample:", JSON.stringify(o).slice(0, 500)); break; }
  }
});
dec.end(buf);
