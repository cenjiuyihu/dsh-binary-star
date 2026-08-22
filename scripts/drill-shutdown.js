"use strict";
/**
 * 受控关闭与孤儿检测演练：
 *  A) control/shutdown → 监督者停止主星并自行退出（不复活）
 *  B) DSH_BINARY_PARENT_PID 指向的父进程死亡 → 监督者自行清理退出
 * 用法: node scripts/drill-shutdown.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const LOCK_FILE = `${STATE}/locks/supervisor.lock`;
const CTRL = `${STATE}/control`;
const SBX_PATCH = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
const CANONICAL_PATCH = "# 双星系统沙箱 profile 补丁层：只挂宿主心跳插件。\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function aliveByTasklist(pid) { return pid ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)) : false; }

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  console.log("=== 受控关闭与孤儿检测演练 ===");
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  for (const f of [STATE_FILE, HB_FILE, LOCK_FILE, `${STATE}/journal.jsonl`, `${CTRL}/shutdown`, `${CTRL}/authorize-takeover.json`, `${CTRL}/handback-request.json`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  for (const sub of ["snapshots", "logs", "seed"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && aliveByTasklist(pre.pid)) killTree(pre.pid);
  const drillStart = Date.now();

  // ── A: 受控关闭 ────────────────────────────────────────
  console.log("\n=== A: control/shutdown 受控关闭 ===");
  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: PROJECT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  sup.stdout.on("data", (d) => process.stdout.write(`[supervisor] ${String(d).trim()}\n`));
  sup.stderr.on("data", (d) => process.stderr.write(`[supervisor:err] ${String(d).trim()}\n`));

  let st = null, h1 = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    st = readJson(STATE_FILE);
    h1 = readJson(HB_FILE);
    if (st && st.primary.state === "RUNNING" && new Date(st.primary.since).getTime() >= drillStart &&
        h1 && h1.health === "ok" && Date.now() - h1.ts <= 8000) break;
  }
  check("监督者确认主星健康", st && st.primary.state === "RUNNING", JSON.stringify(st && st.primary));
  const pid1 = h1 && h1.pid;

  // 写 shutdown
  fs.writeFileSync(`${CTRL}/shutdown`, JSON.stringify({ ts: new Date().toISOString(), by: "drill" }));
  let supGone = false, primaryGone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const lock = readJson(LOCK_FILE);
    supGone = sup.exitCode !== null || (lock && !aliveByTasklist(lock.pid));
    primaryGone = pid1 ? !aliveByTasklist(pid1) : true;
    if (supGone && primaryGone) break;
  }
  check("监督者已退出（锁释放/进程结束）", supGone, `supExit=${sup.exitCode}`);
  check("主星已被停止", primaryGone, `pid=${pid1}`);
  // 等 15 秒确认监督者没有复活主星
  await sleep(15000);
  const hAfter = readJson(HB_FILE);
  const lockAfter = readJson(LOCK_FILE);
  check("无复活（心跳未更新、锁未重建）",
    (!hAfter || !hAfter.pid || !aliveByTasklist(hAfter.pid)) && (!lockAfter || !aliveByTasklist(lockAfter.pid)),
    JSON.stringify({ h: hAfter && hAfter.pid, lock: lockAfter && lockAfter.pid }));

  // ── B: 孤儿检测 ────────────────────────────────────────
  console.log("\n=== B: 父进程死亡 → 监督者自清理 ===");
  // 造一个"假父进程"
  const fakeParent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  await sleep(1000);
  const parentPid = fakeParent.pid;
  const sup2 = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: PROJECT,
    env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG, DSH_BINARY_PARENT_PID: String(parentPid) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  sup2.stdout.on("data", (d) => process.stdout.write(`[sup2] ${String(d).trim()}\n`));
  sup2.stderr.on("data", (d) => process.stderr.write(`[sup2:err] ${String(d).trim()}\n`));
  let st2 = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    st2 = readJson(STATE_FILE);
    if (st2 && st2.primary.state === "RUNNING") break;
  }
  check("监督者2 健康运行", st2 && st2.primary.state === "RUNNING");
  // 杀父进程 → 监督者应在 ~10s tick 内自清理退出
  killTree(parentPid);
  let sup2Gone = false, primary2Gone = false;
  const pid2 = (readJson(HB_FILE) || {}).pid;
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const lock = readJson(LOCK_FILE);
    sup2Gone = sup2.exitCode !== null || (lock && !aliveByTasklist(lock.pid));
    primary2Gone = pid2 ? !aliveByTasklist(pid2) : true;
    if (sup2Gone && primary2Gone) break;
  }
  check("父死后监督者自清理退出", sup2Gone, `sup2Exit=${sup2.exitCode}`);
  check("主星随之停止（无后台残留）", primary2Gone, `pid=${pid2}`);

  // 清理
  console.log("\n=== 清理 ===");
  const hEnd = readJson(HB_FILE);
  if (hEnd && hEnd.pid && aliveByTasklist(hEnd.pid)) killTree(hEnd.pid);
  killTree(sup.pid);
  killTree(sup2.pid);
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  await sleep(2000);

  console.log(`\n==== 关闭/孤儿演练结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
