"use strict";
/**
 * P1b 演练 C：真实监视循环（tick）下的"杀主星 → 自动重启"。
 *
 * 语义（吸取 2026-08-21 的教训）：
 *  - 干净起跑：重置 state/心跳/锁文件，防上一轮遗留数据骗过检查；
 *  - "健康"必须由监督者确认：state.primary.since 晚于本次演练启动（不是遗留的 RUNNING）；
 *  - 恢复判定同理：state.primary.since 晚于杀进程时刻。
 *
 * 本脚本不含硬编码绝对路径：以下常量均在运行时推导（也可用环境变量覆盖）：
 *   DSH_SBX_CONFIG / DSH_SBX_STATE
 * 用法: node scripts/drill-loop.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir().replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const SBX_ROOT = process.env.DSH_SBX_ROOT || path.join(ROOT, "..", ".binary-star").replace(/\\/g, "/");
const SANDBOX_CONFIG = process.env.DSH_SBX_CONFIG || path.join(SBX_ROOT, "config.sandbox.json").replace(/\\/g, "/");
const STATE = process.env.DSH_SBX_STATE || path.join(HOME, ".dsh", "binary-star-sbx").replace(/\\/g, "/");
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const LOCK_FILE = `${STATE}/locks/supervisor.lock`;
const DRILL_LOG = path.join(SBX_ROOT, "drillC.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function aliveByTasklist(pid) {
  if (!pid) return false;
  return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid));
}

async function main() {
  const { isPidAlive } = require("../src/heartbeat");
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  console.log("=== 演练 C：真实监督者循环（tick）→ 杀主星 → 自动重启 ===");

  // ── 干净起跑 ──────────────────────────────────────────
  // 1) 杀掉残留进程（按心跳 pid 与命令行双保险）
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && isPidAlive(pre.pid)) {
    console.log(`[drill] 清理残留主星 pid=${pre.pid}`);
    killTree(pre.pid);
    await sleep(3000);
  }
  const killMatching = (pattern, label) => {
    const out = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${pattern}*' } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: "utf8" }).stdout.trim();
    for (const pidStr of out.split(/\s+/).filter(Boolean)) {
      const pid = Number(pidStr);
      if (pid && pid !== process.pid) { console.log(`[drill] 清理${label} pid=${pid}`); killTree(pid); }
    }
    return out;
  };
  let stray = killMatching("--profile sbx", "游离 sbx 主星");
  let straySup = killMatching("binary-star*cli.js", "游离监督者");
  if (stray || straySup) await sleep(3000);
  // 2) 重置状态/心跳/锁（防遗留数据骗过检查）
  for (const f of [STATE_FILE, HB_FILE, LOCK_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const drillStart = Date.now();

  // ── 启动监督者（真实 tick 循环）────────────────────────
  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: ROOT,
    env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logStream = fs.createWriteStream(DRILL_LOG, { flags: "a" });
  sup.stdout.on("data", (d) => { const s = String(d); process.stdout.write(`[supervisor] ${s.trim()}\n`); logStream.write(s); });
  sup.stderr.on("data", (d) => { const s = String(d); process.stderr.write(`[supervisor:err] ${s.trim()}\n`); logStream.write(s); });

  // ── 等待监督者确认健康（state 由本次运行的健康分支写入）─
  let h1 = null, st1 = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    st1 = readJson(STATE_FILE);
    h1 = readJson(HB_FILE);
    if (
      st1 && st1.primary.state === "RUNNING" &&
      new Date(st1.primary.since).getTime() >= drillStart &&
      h1 && h1.health === "ok" && Date.now() - h1.ts <= 8000
    ) break;
  }
  const healthyConfirmed = st1 && st1.primary.state === "RUNNING" && new Date(st1.primary.since).getTime() >= drillStart;
  check("监督者确认主星健康（state.since 为本轮写入）", healthyConfirmed, JSON.stringify(st1 && st1.primary));
  const pid1 = h1 && h1.pid;
  check("心跳 PID 存在且存活", pid1 && isPidAlive(pid1), `pid=${pid1}`);

  // ── 杀主星 → 等待监督者自动重启并重新确认健康 ─────────
  console.log(`\n[drill] 杀主星 pid=${pid1}`);
  killTree(pid1);
  const killTime = Date.now();

  let h2 = null, st2 = null;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    h2 = readJson(HB_FILE);
    st2 = readJson(STATE_FILE);
    if (
      st2 && st2.primary.state === "RUNNING" &&
      new Date(st2.primary.since).getTime() >= killTime &&
      h2 && h2.health === "ok" && h2.pid !== pid1 && Date.now() - h2.ts <= 8000
    ) break;
  }
  const recovered = st2 && st2.primary.state === "RUNNING" && new Date(st2.primary.since).getTime() >= killTime &&
    h2 && h2.health === "ok" && h2.pid !== pid1;
  check("监督者循环自动重启主星", recovered,
    `state=${st2 && st2.primary.state} since=${st2 && st2.primary.since} pid=${h2 && h2.pid} old=${pid1}`);

  // ── 清理：杀监督者 + 主星，验证死透 ────────────────────
  console.log("\n=== 清理 ===");
  if (h2 && h2.pid) killTree(h2.pid);
  killTree(sup.pid);
  const out2 = spawnSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*binary-star*cli.js*' } | ForEach-Object { $_.ProcessId }",
  ], { encoding: "utf8" }).stdout.trim();
  for (const pidStr of out2.split(/\s+/).filter(Boolean)) {
    const pid = Number(pidStr);
    if (pid && pid !== process.pid) { console.log(`[drill] 补刀游离监督者 pid=${pid}`); killTree(pid); }
  }
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    const hx = readJson(HB_FILE);
    if (!hx || !hx.pid || !isPidAlive(hx.pid)) break;
    console.log(`[drill] 残留主星仍在，再次清理 pid=${hx.pid}`);
    killTree(hx.pid);
  }
  const hEnd = readJson(HB_FILE);
  check("清理后无存活残留", !hEnd || !hEnd.pid || !isPidAlive(hEnd.pid), JSON.stringify(hEnd));

  console.log(`\n==== 演练 C 结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
