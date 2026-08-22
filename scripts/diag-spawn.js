"use strict";
/**
 * 诊断：用监督者同款 spawn 参数拉起沙箱主星，轮询心跳 + 抓完整 stderr。
 * 用法: node scripts/diag-spawn.js
 */
process.env.DSH_BINARY_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { loadConfig, statePaths, ensureStateDirs, primaryCommand } = require("../src/paths");
const hb = require("../src/heartbeat");

const cfg = loadConfig();
const p = ensureStateDirs(cfg);
const cmd = primaryCommand(cfg);

console.log("cmd:", cmd.cmd, cmd.args.join(" "));
console.log("cwd:", cmd.cwd);
console.log("env keys:", Object.keys(cmd.env).filter((k) => /DSH|BINARY/i.test(k)).join(", "));

const child = spawn(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stderr.on("data", (d) => process.stdout.write(`[stderr] ${String(d)}`));
child.stdout.on("data", (d) => process.stdout.write(`[stdout] ${String(d).slice(0, 200)}\n`));
child.on("exit", (code, sig) => console.log(`\n[exit] code=${code} sig=${sig}`));

const deadline = Date.now() + 30000;
const poll = setInterval(() => {
  const h = hb.readHeartbeat(p.heartbeat, "primary");
  let alive = "-";
  if (h) {
    const { spawnSync } = require("node:child_process");
    const tl = spawnSync("tasklist", ["/FI", `PID eq ${h.pid}`, "/NH"], { encoding: "utf8" }).stdout;
    alive = tl.includes(String(h.pid));
  }
  const age = h ? Math.round((Date.now() - h.ts) / 1000) : "-";
  console.log(`t+${Math.round((Date.now() - deadline + 30000) / 1000)}s heartbeat=${h ? `pid=${h.pid} age=${age}s alive=${alive}` : "NONE"} childAlive=${child.exitCode === null}`);
  if (Date.now() > deadline) {
    clearInterval(poll);
    if (child.exitCode === null) { child.kill(); }
    process.exit(0);
  }
}, 2000);
