"use strict";
/**
 * P3 演练：代班接管全流程。
 *  1. 监督者运行、主星健康
 *  2. 杀主星 + 改坏 patch（无账目/快照可救）→ 快速路径失败 → 阶梯用尽
 *  3. 人工授权（authorize-takeover.json）→ 顶班：种子 + 代班实例（web profile :3180）
 *  4. 验证：state=TAKEOVER、HTTP 200、种子文件含消息
 *  5. 交回（handback-request.json）→ 代班停止 → 会话归档 → 主星恢复 RUNNING
 *
 * 安全边界：只动 profiles/sbx 与沙箱状态目录；代班实例用 3180（不碰真实 :3080）；
 * storages/ 文件演练前备份、结束后还原。
 * 用法: node scripts/drill-p3.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const BIN = "C:/Users/cxm20/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const CTRL = `${STATE}/control`;
const SBX_PATCH = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
const STORAGES = "C:/Users/cxm20/.dsh/storages";
const STORAGES_BACKUP = "D:/DSH/.binary-star/storages-backup";
const TAKEOVER_PORT = 3180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function aliveByTasklist(pid) { return pid ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)) : false; }
function httpOk(url, timeoutMs = 3000) {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `try { (Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 3).StatusCode } catch { 0 }`], { encoding: "utf8", timeout: timeoutMs + 2000 });
    const code = String(out).trim();
    return code !== "" && code !== "0";
  } catch { return false; }
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  console.log("=== P3 演练：代班接管全流程 ===");

  // ── 预检与干净起跑 ────────────────────────────────────
  // 自愈：起跑时强制把沙箱 patch 恢复为规范内容（防上轮中断的演练残留污染）
  const CANONICAL_PATCH = "# 双星系统沙箱 profile 补丁层：只挂宿主心跳插件。\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  const original = fs.readFileSync(SBX_PATCH, "utf8");
  const preflight = spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: "D:/DSH/.binary-star/sbx-workspace", encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (preflight.status !== 0) { console.error("[drill] 预检失败: sbx 配置不可解析（自愈写入后仍失败）"); process.exit(2); }
  console.log("[drill] 预检通过（patch 已自愈为规范内容）");
  fs.mkdirSync(STORAGES_BACKUP, { recursive: true });
  for (const f of fs.readdirSync(STORAGES)) {
    fs.copyFileSync(`${STORAGES}/${f}`, `${STORAGES_BACKUP}/${f}`);
  }
  for (const f of [STATE_FILE, HB_FILE, `${STATE}/locks/supervisor.lock`, `${STATE}/journal.jsonl`, `${CTRL}/authorize-takeover.json`, `${CTRL}/handback-request.json`, `${CTRL}/halt`, `${CTRL}/takeover-signal.json`, `${CTRL}/restart-request.json`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  for (const sub of ["snapshots", "logs", "seed"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && aliveByTasklist(pre.pid)) killTree(pre.pid);
  const drillStart = Date.now();

  // ── 启动监督者 ─────────────────────────────────────────
  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: PROJECT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  sup.stdout.on("data", (d) => process.stdout.write(`[supervisor] ${String(d).trim()}\n`));
  sup.stderr.on("data", (d) => process.stderr.write(`[supervisor:err] ${String(d).trim()}\n`));

  let h1 = null, st1 = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    st1 = readJson(STATE_FILE);
    h1 = readJson(HB_FILE);
    if (st1 && st1.primary.state === "RUNNING" && new Date(st1.primary.since).getTime() >= drillStart &&
        h1 && h1.health === "ok" && Date.now() - h1.ts <= 8000) break;
  }
  check("监督者确认主星健康", st1 && st1.primary.state === "RUNNING", JSON.stringify(st1 && st1.primary));
  const pid1 = h1 && h1.pid;

  // ── 制造不可救故障：杀主星 + 坏 patch（无账目/快照）───
  console.log("\n=== 制造不可救故障 ===");
  killTree(pid1);
  fs.writeFileSync(SBX_PATCH, original + "\n- insert: [\n    - id: broken\n");
  const badDump = spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: "D:/DSH/.binary-star/sbx-workspace", encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  check("故障真实有效（dump-config 失败）", badDump.status !== 0, `status=${badDump.status}`);

  // ── 等阶梯用尽 → 等待授权 ─────────────────────────────
  console.log("\n=== 等待阶梯用尽 → 顶班等待 ===");
  let stWait = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    stWait = readJson(STATE_FILE);
    if (stWait && stWait.primary.state === "DOWN" && stWait.primary.detail && stWait.primary.detail.includes("顶班授权")) break;
  }
  check("阶梯用尽进入顶班等待", stWait && stWait.primary.detail && stWait.primary.detail.includes("顶班授权"), stWait && stWait.primary.detail);

  // 人工授权
  fs.writeFileSync(`${CTRL}/authorize-takeover.json`, JSON.stringify({ ts: new Date().toISOString(), by: "drill" }));

  // ── 等代班就绪 ─────────────────────────────────────────
  let stTake = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    stTake = readJson(STATE_FILE);
    if (stTake && stTake.satellite.state === "TAKEOVER") break;
  }
  check("卫星进入 TAKEOVER", stTake && stTake.satellite.state === "TAKEOVER", JSON.stringify(stTake && stTake.satellite));
  check("代班实例 HTTP 就绪（:3180）", httpOk(`http://127.0.0.1:${TAKEOVER_PORT}/`));
  const seedMeta = readJson(`${STATE}/seed/latest.meta.json`);
  check("会话种子已生成", seedMeta && seedMeta.messageCount > 0, JSON.stringify(seedMeta && { sessionId: seedMeta.sessionId, messageCount: seedMeta.messageCount }));
  check("状态记录代班 pid", stTake && stTake.takeover && stTake.takeover.pid, JSON.stringify(stTake && stTake.takeover));

  // ── 交回 ───────────────────────────────────────────────
  console.log("\n=== 交回 ===");
  // 模拟"人工已修复主星配置"，再请求交回（交回后主星才能重启成功）
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  fs.writeFileSync(`${CTRL}/handback-request.json`, JSON.stringify({ ts: new Date().toISOString(), by: "drill" }));
  const handbackTime = Date.now();
  const oldTakePid = stTake && stTake.takeover && stTake.takeover.pid;
  let stBack = null, hBack = null;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    stBack = readJson(STATE_FILE);
    hBack = readJson(HB_FILE);
    if (stBack && stBack.primary.state === "RUNNING" && new Date(stBack.primary.since).getTime() >= handbackTime &&
        stBack.satellite.state === "STANDBY" && hBack && hBack.health === "ok") break;
  }
  check("主星交回后恢复 RUNNING", stBack && stBack.primary.state === "RUNNING", JSON.stringify(stBack && stBack.primary));
  check("卫星回到 STANDBY", stBack && stBack.satellite.state === "STANDBY", stBack && stBack.satellite.state);
  check("代班实例已停止", oldTakePid ? !aliveByTasklist(oldTakePid) : true, `pid=${oldTakePid}`);

  // ── 清理与还原 ─────────────────────────────────────────
  console.log("\n=== 清理 ===");
  const hLast = readJson(HB_FILE);
  if (hLast && hLast.pid) killTree(hLast.pid);
  killTree(sup.pid);
  const out2 = spawnSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*--profile sbx*' -or $_.CommandLine -like '*--port 3180*' -or $_.CommandLine -like '*binary-star*cli.js*') } | ForEach-Object { $_.ProcessId }",
  ], { encoding: "utf8" }).stdout.trim();
  for (const pidStr of out2.split(/\s+/).filter(Boolean)) {
    const pid = Number(pidStr);
    if (pid && pid !== process.pid) { killTree(pid); }
  }
  fs.writeFileSync(SBX_PATCH, original);
  for (const f of fs.readdirSync(STORAGES_BACKUP)) {
    fs.copyFileSync(`${STORAGES_BACKUP}/${f}`, `${STORAGES}/${f}`);
  }
  await sleep(3000);
  const hEnd = readJson(HB_FILE);
  check("清理后无存活残留", !hEnd || !hEnd.pid || !aliveByTasklist(hEnd.pid));
  check("sbx patch 已还原", fs.readFileSync(SBX_PATCH, "utf8") === original);

  console.log(`\n==== P3 演练结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
