"use strict";
/**
 * 交接演练：模拟"桌面壳已拉起主星"→ 再启动监督者 → 应执行一次性接管
 * （杀旧进程 → 拉起带 token 的新实例），不得出现端口冲突循环。
 * 用法: node scripts/drill-handover.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const BIN = "C:/Users/cxm20/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
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

  console.log("=== 交接演练：桌面壳主星 → 监督者接管 ===");
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  for (const f of [STATE_FILE, HB_FILE, `${STATE}/locks/supervisor.lock`, `${STATE}/journal.jsonl`, `${STATE}/heartbeat/primary.json.tmp`]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} }
  for (const sub of ["snapshots", "logs", "seed", "control"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && aliveByTasklist(pre.pid)) killTree(pre.pid);
  const drillStart = Date.now();

  // 1) 模拟桌面壳：直接拉起主星（无 token）
  console.log("\n[1] 模拟桌面壳拉起主星（无 token）");
  const foreign = spawn(process.execPath, [BIN, "--profile", "sbx"], {
    cwd: "D:/DSH/.binary-star/sbx-workspace",
    env: { ...process.env, DSH_BINARY_ROLE: "primary", DSH_BINARY_STATE: STATE, DSH_BINARY_HEARTBEAT_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let hF = null;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    hF = readJson(HB_FILE);
    if (hF && hF.health === "ok") break;
  }
  check("桌面壳主星心跳出现（token=none）", hF && hF.health === "ok" && (!hF.token || hF.token === "none"), JSON.stringify(hF && { pid: hF.pid, token: hF.token }));
  const foreignPid = hF && hF.pid;
  check("桌面壳主星存活", foreignPid && aliveByTasklist(foreignPid), `pid=${foreignPid}`);

  // 2) 启动监督者
  console.log("\n[2] 启动监督者（应执行一次性接管）");
  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: PROJECT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  sup.stdout.on("data", (d) => process.stdout.write(`[supervisor] ${String(d).trim()}\n`));
  sup.stderr.on("data", (d) => process.stderr.write(`[supervisor:err] ${String(d).trim()}\n`));

  // 3) 等待接管完成：state RUNNING（本轮写入）+ 心跳带 token + pid 变化
  let st = null, hNew = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    st = readJson(STATE_FILE);
    hNew = readJson(HB_FILE);
    if (st && st.primary.state === "RUNNING" && new Date(st.primary.since).getTime() >= drillStart &&
        hNew && hNew.health === "ok" && hNew.token && hNew.token !== "none" && hNew.pid !== foreignPid) break;
  }
  check("监督者接管完成（RUNNING + 带 token + 新 pid）",
    st && st.primary.state === "RUNNING" && hNew && hNew.token && hNew.token !== "none" && hNew.pid !== foreignPid,
    `old=${foreignPid} new=${hNew && hNew.pid} token=${hNew && hNew.token}`);
  check("桌面壳旧主星已被交接终止", foreignPid ? !aliveByTasklist(foreignPid) : true, `pid=${foreignPid}`);
  // 无 EADDRINUSE 循环：监督者日志不应出现端口占用错误
  const supLog = fs.existsSync(`${STATE}/logs/supervisor.log`) ? fs.readFileSync(`${STATE}/logs/supervisor.log`, "utf8") : "";
  check("无端口冲突循环", !supLog.includes("EADDRINUSE"), "(见 supervisor.log)");

  // 清理
  console.log("\n=== 清理 ===");
  const hEnd = readJson(HB_FILE);
  if (hEnd && hEnd.pid) killTree(hEnd.pid);
  killTree(sup.pid);
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    const hx = readJson(HB_FILE);
    if (!hx || !hx.pid || !aliveByTasklist(hx.pid)) break;
    killTree(hx.pid);
  }
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  const hF2 = readJson(HB_FILE);
  check("清理后无存活残留", !hF2 || !hF2.pid || !aliveByTasklist(hF2.pid));

  console.log(`\n==== 交接演练结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
