"use strict";
/**
 * P3 探索 2：createZstdDecompress 流式解压拼接帧（只读）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { createZstdDecompress } = require("node:zlib");

const SESSIONS = "C:/Users/cxm20/.dsh/sessions/--D-DSH--";
const target = process.argv[2] || fs.readdirSync(SESSIONS).sort((a, b) =>
  fs.statSync(path.join(SESSIONS, b)).mtimeMs - fs.statSync(path.join(SESSIONS, a)).mtimeMs)[0];
const file = path.join(SESSIONS, target, "session.jsonl.zstd");
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
