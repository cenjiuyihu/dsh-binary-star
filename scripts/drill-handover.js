"use strict";
/**
 * 沙箱演练 HANDOVER：交接主星所有权（重启换主）。
 * 安全边界：只操作沙箱目录与状态目录 binary-star-sbx。
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
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

  for (const f of [STATE_FILE, HB_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }
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

  // 模拟用户手动重启主星：kill 旧主星（心跳仍新鲜时，监督者应识别为手over而非崩溃）
  console.log("\n=== 交接：kill 旧主星 ===");
  killTree(pid1);
  const t0 = Date.now();
  let h2 = null, st2 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    h2 = readJson(HB_FILE);
    st2 = readJson(STATE_FILE);
    if (st2 && st2.primary.state === "RUNNING" && h2 && h2.health === "ok" && h2.pid !== pid1) break;
  }
  check("新主星接管（pid 变化）", h2 && h2.pid !== pid1, `old=${pid1} new=${h2 && h2.pid}`);
  check("状态 RUNNING", st2 && st2.primary.state === "RUNNING", st2 && st2.primary.state);
  check("接管发生在合理时间窗内（<90s）", Date.now() - t0 < 90000, `${Math.round((Date.now() - t0) / 1000)}s`);

  console.log("\n=== 清理 ===");
  if (h2 && h2.pid) killTree(h2.pid);
  killTree(sup.pid);
  await sleep(2000);
  console.log(`\n==== HANDOVER 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
