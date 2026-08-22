"use strict";
/**
 * 沙箱演练 SHUTDOWN：受控关闭（control/shutdown）与孤儿检测。
 * 安全边界：只操作沙箱目录与状态目录 binary-star-sbx。
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const SHUTDOWN_FILE = `${STATE}/control/shutdown`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function alive(pid) {
  if (!pid) return false;
  try { return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)); } catch { return false; }
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  for (const f of [STATE_FILE, HB_FILE, SHUTDOWN_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && alive(pre.pid)) killTree(pre.pid);
  await sleep(1500);

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
    if (st1 && st1.primary.state === "RUNNING" && h1 && h1.health === "ok") break;
  }
  check("监督者启动主星健康", st1 && st1.primary.state === "RUNNING" && h1 && h1.health === "ok", JSON.stringify(st1 && st1.primary));
  const pid1 = h1 && h1.pid;

  console.log("\n=== A: 受控关闭 ===");
  fs.mkdirSync(`${STATE}/control`, { recursive: true });
  fs.writeFileSync(SHUTDOWN_FILE, new Date().toISOString());
  let st2 = null;
  for (let i = 0; i < 15; i++) {
    await sleep(5000);
    st2 = readJson(STATE_FILE);
    if (st2 && st2.primary.state === "STOPPED") break;
  }
  check("主星进入 STOPPED", st2 && st2.primary.state === "STOPPED", st2 && st2.primary.state);
  check("主星进程已退出", !alive(pid1));
  check("shutdown 文件被清除", !fs.existsSync(SHUTDOWN_FILE));

  console.log("\n=== B: 孤儿检测（无 shutdown 时 kill 主星 → 监督者应重启）===");
  // 先恢复运行
  fs.mkdirSync(`${STATE}/control`, { recursive: true });
  fs.rmSync(SHUTDOWN_FILE, { force: true });
  let st3 = null, h3 = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    st3 = readJson(STATE_FILE);
    h3 = readJson(HB_FILE);
    if (st3 && st3.primary.state === "RUNNING" && h3 && h3.health === "ok") break;
  }
  check("恢复 RUNNING", st3 && st3.primary.state === "RUNNING" && h3 && h3.health === "ok", st3 && st3.primary.state);
  const pid2 = h3 && h3.pid;
  killTree(pid2);
  let st4 = null, h4 = null, ok = false;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    st4 = readJson(STATE_FILE);
    h4 = readJson(HB_FILE);
    if (st4 && st4.primary.state === "RUNNING" && h4 && h4.health === "ok" && h4.pid !== pid2) { ok = true; break; }
  }
  check("无 shutdown 时 kill 主星被自动重启", ok, JSON.stringify(st4 && st4.primary));
  check("重启后 pid 变化", h4 && h4.pid !== pid2, `old=${pid2} new=${h4 && h4.pid}`);

  console.log("\n=== 清理 ===");
  if (h4 && h4.pid) killTree(h4.pid);
  killTree(sup.pid);
  await sleep(2000);
  console.log(`\n==== SHUTDOWN 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
