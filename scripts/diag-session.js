"use strict";
/**
 * P3 探索：zstd 解压真实会话文件，观察 JSONL 结构（只读，不修改任何数据）。
 * 自动定位 dsh 会话根下最近有内容的工作区目录，无需硬编码路径。
 * 用法: node scripts/diag-session.js [sessionId]
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { zstdDecompressSync } = require("node:zlib");

const SESSIONS_ROOT = process.env.DSH_SESSIONS || path.join(os.homedir(), ".dsh", "sessions");

// 找会话根下最新的工作区目录（每个工作区含多个 session-* 目录）
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
console.log("session:", target);
console.log("size:", fs.statSync(file).size);

const buf = fs.readFileSync(file);
const text = zstdDecompressSync(buf).toString("utf8");
const lines = text.split("\n").filter(Boolean);
console.log("decompressed lines:", lines.length);

for (const l of lines.slice(0, 3)) {
  const o = JSON.parse(l);
  console.log("type:", o.type, "| keys:", Object.keys(o).join(","));
  if (o.type === "session") console.log("  header:", JSON.stringify(o).slice(0, 400));
  else console.log("  sample:", JSON.stringify(o).slice(0, 300));
}
// 统计记录类型
const types = {};
for (const l of lines) { try { types[JSON.parse(l).type] = (types[JSON.parse(l).type] || 0) + 1; } catch {} }
console.log("type counts:", JSON.stringify(types));
