"use strict";
/**
 * 二分诊断：真实 Supervisor 类 + 顶层进程 spawn，监视 60s。
 * 记录：primaryProc.pid vs 心跳 pid、完整 stderr、退出码、cordis.yml 是否被改写。
 * 本脚本不含硬编码绝对路径：路径均在运行时推导（可用 DSH_SBX_CONFIG / DSH_SBX_PATCH 覆盖）。
 * 用法: node scripts/diag-supervisor.js
 */
const os = require("node:os");
const path = require("node:path");
const HOME = os.homedir().replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const SBX_ROOT = process.env.DSH_SBX_ROOT || path.join(ROOT, "..", ".binary-star").replace(/\\/g, "/");
process.env.DSH_BINARY_CONFIG = process.env.DSH_SBX_CONFIG || path.join(SBX_ROOT, "config.sandbox.json").replace(/\\/g, "/");
const fs = require("node:fs");
const { loadConfig, statePaths, ensureStateDirs } = require("../src/paths");
const hb = require("../src/heartbeat");
const { Supervisor } = require("../src/supervisor");

const cfg = loadConfig();
const p = ensureStateDirs(cfg);
const sup = new Supervisor(cfg, p, { autoConfirm: true });
const PATCH = process.env.DSH_SBX_PATCH || path.join(HOME, ".dsh", "profiles", "sbx", "cordis.yml");

const before = fs.readFileSync(PATCH, "utf8");
const t0 = Date.now();
sup.spawnPrimary();
const procPid = sup.primaryProc && sup.primaryProc.pid;
console.log(`[diag] primaryProc.pid=${procPid}`);

let lastHb = null;
const iv = setInterval(() => {
  const h = hb.readHeartbeat(p.heartbeat, "primary");
  const now = Date.now();
  if (h && JSON.stringify(h) !== JSON.stringify(lastHb)) {
    const age = Math.round((now - h.ts) / 1000);
    console.log(`[diag] t+${Math.round((now - t0) / 1000)}s hb.pid=${h.pid} age=${age}s health=${h.health} (procAlive=${hb.isPidAlive(h.pid)})`);
    lastHb = h;
  }
  if (now - t0 > 60000) {
    clearInterval(iv);
    const after = fs.readFileSync(PATCH, "utf8");
    console.log(`[diag] 60s 结束: primaryProc=${sup.primaryProc ? "alive" : "exited"} exitCode=${sup.primaryProc ? sup.primaryProc.exitCode : "n/a"} heartbeatPidAlive=${lastHb ? hb.isPidAlive(lastHb.pid) : "-"}`);
    console.log(`[diag] cordis.yml 被改写: ${before !== after}`);
    if (sup.primaryProc) { sup.stop(); }
    process.exit(0);
  }
}, 1000);
