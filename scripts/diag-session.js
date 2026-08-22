"use strict";
/**
 * P3 探索：zstd 解压真实会话文件，观察 JSONL 结构（只读，不修改任何数据）。
 * 用法: node scripts/diag-session.js [sessionId]
 */
const fs = require("node:fs");
const path = require("node:path");
const { zstdDecompressSync } = require("node:zlib");

const SESSIONS = "C:/Users/cxm20/.dsh/sessions/--D-DSH--";
const target = process.argv[2] || fs.readdirSync(SESSIONS).sort((a, b) =>
  fs.statSync(path.join(SESSIONS, b)).mtimeMs - fs.statSync(path.join(SESSIONS, a)).mtimeMs)[0];
const file = path.join(SESSIONS, target, "session.jsonl.zstd");
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
