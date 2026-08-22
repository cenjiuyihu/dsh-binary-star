"use strict";
/**
 * 沙箱演练 P3：全链路接管 + 顶班 + 交回（成功路径 + 授权文件中断路径）。
 * 安全边界：只操作沙箱目录 D:/DSH/.binary-star/sbx-workspace 与状态目录 binary-star-sbx。
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const BIN = "C:/Users/cxm20/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_PRIMARY = `${STATE}/heartbeat/primary.json`;
const HB_SAT = `${STATE}/heartbeat/satellite.json`;
const CTRL = `${STATE}/control`;
const AUTH_FILE = `${CTRL}/authorize`;
const TAKEOVER_DIR = `${CTRL}/takeover`;
const HANDBACK_FILE = `${CTRL}/handback-request.json`;
const SESSIONS = "D:/DSH/.binary-star/sbx-workspace/sessions";
const SESSIONS_ARCHIVE = "D:/DSH/.binary-star/sbx-workspace/sessions.archive";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function alive(pid) {
  if (!pid) return false;
  try { return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)); } catch { return false; }
}
function runCli(args) {
  const r = spawnSync(process.execPath, ["src/cli.js", ...args], {
    cwd: PROJECT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: r.status, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim() };
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  // ---- 清理现场 ----
  for (const f of [STATE_FILE, HB_PRIMARY, HB_SAT, AUTH_FILE, HANDBACK_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(`${CTRL}/supervisor.lock`, { force: true }); } catch {}
  try { for (const n of fs.readdirSync(TAKEOVER_DIR)) fs.rmSync(`${TAKEOVER_DIR}/${n}`, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SESSIONS_ARCHIVE, { recursive: true, force: true }); } catch {}
  for (const pre of [readJson(HB_PRIMARY), readJson(HB_SAT)]) {
    if (pre && pre.pid && alive(pre.pid)) killTree(pre.pid);
  }
  await sleep(1500);

  // ---- 造一个卫星会话，供交回归档 ----
  fs.mkdirSync(SESSIONS, { recursive: true });
  const fakeSessionId = "sat-archive-test";
  fs.mkdirSync(`${SESSIONS}/${fakeSessionId}`, { recursive: true });
  fs.writeFileSync(`${SESSIONS}/${fakeSessionId}/message.jsonl`, "{\"role\":\"user\",\"content\":\"p3 演练消息\"}\n");

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
    h1 = readJson(HB_PRIMARY);
    if (st1 && st1.primary.state === "RUNNING" && h1 && h1.health === "ok") break;
  }
  check("监督者启动主星健康", st1 && st1.primary.state === "RUNNING" && h1 && h1.health === "ok", JSON.stringify(st1 && st1.primary));
  const pid1 = h1 && h1.pid;

  // ---- 模拟主星崩溃（不留授权文件）→ 超时后卫星接管 ----
  console.log("\n=== A: 主星崩溃 → 卫星接管 ===");
  killTree(pid1);
  const t0 = Date.now();
  let hSat = null, st2 = null;
  for (let i = 0; i < 90; i++) {
    await sleep(5000);
    hSat = readJson(HB_SAT);
    st2 = readJson(STATE_FILE);
    if (st2 && st2.mode === "takeover" && st2.satellite.state === "RUNNING" && hSat && hSat.health === "ok") break;
  }
  const tookMs = Date.now() - t0;
  check("卫星进入接管模式且健康", st2 && st2.mode === "takeover" && st2.satellite.state === "RUNNING" && hSat && hSat.health === "ok", JSON.stringify(st2 && { mode: st2.mode, satellite: st2.satellite }));
  check("接管发生在合理时间窗内（30~240s）", tookMs >= 30000 && tookMs <= 240000, `${Math.round(tookMs / 1000)}s`);
  check("接管后生成 seed 文件", fs.existsSync(`${TAKEOVER_DIR}/seed/latest.txt`));

  // ---- 授权文件 → 卫星正常服务中 ----
  console.log("\n=== B: 授权文件出现 → 卫星保持服务（此时不交回）===");
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ ts: new Date().toISOString(), note: "p3 演练授权" }));
  await sleep(15000);
  const st3 = readJson(STATE_FILE);
  check("授权后卫星仍在服务（未交回）", st3 && st3.mode === "takeover" && st3.satellite.state === "RUNNING");
  check("授权文件已被消费清除", !fs.existsSync(AUTH_FILE));

  // ---- 请求交回 ----
  console.log("\n=== C: 交回 ===");
  fs.writeFileSync(HANDBACK_FILE, JSON.stringify({ ts: new Date().toISOString(), reason: "p3: 用户请求交回" }));
  let st4 = null, h2 = null, handbackGone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    st4 = readJson(STATE_FILE);
    h2 = readJson(HB_PRIMARY);
    handbackGone = !fs.existsSync(HANDBACK_FILE);
    if (st4 && st4.mode === "normal" && st4.primary.state === "RUNNING" && h2 && h2.health === "ok") break;
  }
  check("交回后回到 normal 模式主星恢复", st4 && st4.mode === "normal" && st4.primary.state === "RUNNING" && h2 && h2.health === "ok", JSON.stringify(st4 && { mode: st4.mode, primary: st4.primary }));
  check("handback-request 已消费清除", handbackGone);
  check("卫星会话已归档到 sessions.archive", fs.existsSync(`${SESSIONS_ARCHIVE}/${fakeSessionId}`));
  check("原 sessions 目录已清空", !fs.existsSync(`${SESSIONS}/${fakeSessionId}`));

  console.log("\n=== 清理 ===");
  for (const pre of [readJson(HB_PRIMARY), readJson(HB_SAT)]) {
    if (pre && pre.pid && alive(pre.pid)) killTree(pre.pid);
  }
  killTree(sup.pid);
  await sleep(2000);
  let left = 0;
  for (const pre of [readJson(HB_PRIMARY), readJson(HB_SAT)]) {
    if (pre && pre.pid && alive(pre.pid)) { left++; killTree(pre.pid); }
  }
  check("清理后无存活残留", left === 0);

  console.log(`\n==== P3 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
