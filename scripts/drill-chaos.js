"use strict";
/**
 * P4 混沌演练：
 *  S1 挂死（D3）：挂起主星进程（心跳停、进程在）→ 监督者强杀重启 → RUNNING
 *  S2 boot loop（坏 patch）：快速路径失败 → 阶梯用尽 → 顶班等待 + 修复报告生成
 *  S3 代班自愈：授权顶班 → 杀掉代班实例 → 监督者 10s 后自愈重启 → HTTP 恢复
 *
 * 安全边界：只动 profiles/sbx 与沙箱状态目录；代班用 :3180；storages 前后备份还原。
 * 用法: node scripts/drill-chaos.js
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
const SUP_LOG = `${STATE}/logs/supervisor.log`;
const REPAIR_DIR = `${STATE}/logs/repair`;
const SBX_PATCH = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
const STORAGES = "C:/Users/cxm20/.dsh/storages";
const STORAGES_BACKUP = "D:/DSH/.binary-star/storages-backup";
const CANONICAL_PATCH = "# 双星系统沙箱 profile 补丁层：只挂宿主心跳插件。\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";
const TAKEOVER_PORT = 3180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function aliveByTasklist(pid) { return pid ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)) : false; }
function httpOk(url, timeoutMs = 3000) {
  try {
    const out = spawnSync("powershell", ["-NoProfile", "-Command", `try { (Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 3).StatusCode } catch { 0 }`], { encoding: "utf8", timeout: timeoutMs + 2000 }).stdout;
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

  console.log("=== P4 混沌演练 ===");

  // ── 自愈预检 + 干净起跑 ───────────────────────────────
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  const preflight = spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: "D:/DSH/.binary-star/sbx-workspace", encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (preflight.status !== 0) { console.error("[drill] 预检失败"); process.exit(2); }
  fs.mkdirSync(STORAGES_BACKUP, { recursive: true });
  for (const f of fs.readdirSync(STORAGES)) fs.copyFileSync(`${STORAGES}/${f}`, `${STORAGES_BACKUP}/${f}`);
  for (const f of [STATE_FILE, HB_FILE, `${STATE}/locks/supervisor.lock`, `${STATE}/journal.jsonl`, `${STATE}/heartbeat/primary.json.tmp`]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} }
  for (const sub of ["snapshots", "logs", "seed", "control"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && aliveByTasklist(pre.pid)) killTree(pre.pid);
  const drillStart = Date.now();

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

  // ── S1: 挂死（D3，进程在、心跳停）─────────────────────
  console.log("\n=== S1: 挂死（进程在、心跳停）===");
  // 模拟"进程活着但心跳停"：把 primary.json.tmp 变成目录 → 插件每次写 tmp 都失败
  // （rename 不再发生）→ 心跳保持最后一次成功写入 → 30s 后过期 → 监督者应判 D3 强杀重启
  const HB_DIR = `${STATE}/heartbeat`;
  const tmpObstacle = `${HB_DIR}/primary.json.tmp`;
  fs.mkdirSync(tmpObstacle, { recursive: true });
  let sawD3 = false;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const supLogNow = fs.existsSync(SUP_LOG) ? fs.readFileSync(SUP_LOG, "utf8") : "";
    if (supLogNow.includes("检测到故障: D3")) { sawD3 = true; break; }
  }
  check("监督者识别 D3（心跳停但进程在）", sawD3, "(见 supervisor.log)");
  // 撤除障碍，让重启后的新进程能正常写心跳
  try { fs.rmdirSync(tmpObstacle); } catch {}
  let stS1 = null, hS1 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    stS1 = readJson(STATE_FILE);
    hS1 = readJson(HB_FILE);
    if (stS1 && stS1.primary.state === "RUNNING" && hS1 && hS1.health === "ok" && hS1.pid !== pid1) break;
  }
  check("D3 强杀重启（新 PID + RUNNING）", stS1 && stS1.primary.state === "RUNNING" && hS1 && hS1.pid !== pid1,
    `old=${pid1} new=${hS1 && hS1.pid} state=${stS1 && stS1.primary.state}`);

  // ── S2: boot loop（坏 patch）→ 阶梯用尽 + 修复报告 ────
  console.log("\n=== S2: boot loop → 阶梯用尽 + 修复报告 ===");
  const pid2 = hS1 && hS1.pid;
  killTree(pid2);
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH + "\n- insert: [\n    - id: broken\n");
  let stS2 = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    stS2 = readJson(STATE_FILE);
    if (stS2 && stS2.primary.detail && stS2.primary.detail.includes("顶班授权")) break;
  }
  check("阶梯用尽进入顶班等待", stS2 && stS2.primary.detail && stS2.primary.detail.includes("顶班授权"), stS2 && stS2.primary.detail);
  const reports = fs.existsSync(REPAIR_DIR) ? fs.readdirSync(REPAIR_DIR).filter((n) => n.endsWith(".json")) : [];
  const lastReport = reports.length ? readJson(`${REPAIR_DIR}/${reports.sort().pop()}`) : null;
  check("修复报告已生成", !!lastReport, JSON.stringify(reports));
  check("修复报告 outcome=exhausted", lastReport && lastReport.outcome === "exhausted", lastReport && lastReport.outcome);
  check("修复报告含步骤明细", lastReport && Array.isArray(lastReport.steps) && lastReport.steps.length > 0, `steps=${lastReport && lastReport.steps.length}`);

  // ── S3: 顶班 → 杀代班 → 自愈 ──────────────────────────
  console.log("\n=== S3: 顶班 → 代班被杀 → 自愈 ===");
  fs.writeFileSync(`${CTRL}/authorize-takeover.json`, JSON.stringify({ ts: new Date().toISOString(), by: "drill" }));
  let stTake = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    stTake = readJson(STATE_FILE);
    if (stTake && stTake.satellite.state === "TAKEOVER") break;
  }
  check("卫星进入 TAKEOVER", stTake && stTake.satellite.state === "TAKEOVER", JSON.stringify(stTake && stTake.satellite));
  check("代班实例 HTTP 就绪", httpOk(`http://127.0.0.1:${TAKEOVER_PORT}/`));
  const takePid = stTake && stTake.takeover && stTake.takeover.pid;
  check("代班 pid 已记录", !!takePid, `pid=${takePid}`);

  killTree(takePid);
  let stHeal = null, healed = false;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    stHeal = readJson(STATE_FILE);
    if (stHeal && stHeal.takeover && stHeal.takeover.pid && stHeal.takeover.pid !== takePid && httpOk(`http://127.0.0.1:${TAKEOVER_PORT}/`)) { healed = true; break; }
  }
  check("代班被杀后自愈重启（新 pid + HTTP 恢复）", healed, `old=${takePid} new=${stHeal && stHeal.takeover && stHeal.takeover.pid}`);

  // ── 清理 ──────────────────────────────────────────────
  console.log("\n=== 清理 ===");
  const hLast = readJson(HB_FILE);
  if (hLast && hLast.pid) killTree(hLast.pid);
  killTree(sup.pid);
  const out2 = spawnSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*--profile sbx*' -or $_.CommandLine -like '*--port 3180*' -or $_.CommandLine -like '*--port 3181*' -or $_.CommandLine -like '*binary-star*cli.js*') } | ForEach-Object { $_.ProcessId }",
  ], { encoding: "utf8" }).stdout.trim();
  for (const pidStr of out2.split(/\s+/).filter(Boolean)) {
    const pid = Number(pidStr);
    if (pid && pid !== process.pid) killTree(pid);
  }
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  for (const f of fs.readdirSync(STORAGES_BACKUP)) fs.copyFileSync(`${STORAGES_BACKUP}/${f}`, `${STORAGES}/${f}`);
  await sleep(3000);
  const hEnd = readJson(HB_FILE);
  check("清理后无存活残留", !hEnd || !hEnd.pid || !aliveByTasklist(hEnd.pid));
  check("sbx patch 已还原", fs.readFileSync(SBX_PATCH, "utf8") === CANONICAL_PATCH);

  console.log(`\n==== P4 混沌演练结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
