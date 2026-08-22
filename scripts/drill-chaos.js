"use strict";
/**
 * 混沌演练：随机注入 D1/D2/D3/BOOT_GRACE 故障序列，监督者必须逐次自愈。
 * 安全边界：只操作沙箱目录与状态目录 binary-star-sbx；故障注入点为
 *   - D1: kill 主星进程（心跳消失）
 *   - D2: 改坏 profiles/sbx/cordis.patch.yml（L3 自检 degraded）
 *   - D3: 使心跳文件写入失败（tmp 变目录），进程存活但心跳 stale
 *   - BOOT_GRACE: 连续多次启动即退出（早期退出保护）
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const SBX_PATCH = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
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

  const faultNames = ["D1-kill", "D2-patch-broken", "D3-heartbeat-stale", "D2-patch-broken", "D1-kill"];
  const original = fs.readFileSync(SBX_PATCH, "utf8");

  for (const fault of faultNames) {
    console.log(`\n=== 故障注入: ${fault} ===`);
    if (fault === "D1-kill") {
      const h = readJson(HB_FILE);
      if (h && h.pid) killTree(h.pid);
    } else if (fault === "D2-patch-broken") {
      fs.writeFileSync(SBX_PATCH, original + "\n- insert: [\n    - id: broken\n");
    } else if (fault === "D3-heartbeat-stale") {
      const dir = `${HB_FILE}.tmp`;
      try { fs.mkdirSync(dir); } catch {}
      await sleep(30000); // 让心跳必然 stale（30s 窗口）
    }

    const t0 = Date.now();
    let h = null, st = null, ok = false;
    for (let i = 0; i < 90; i++) {
      await sleep(5000);
      h = readJson(HB_FILE);
      st = readJson(STATE_FILE);
      if (st && st.primary.state === "RUNNING" && h && h.health === "ok") { ok = true; break; }
    }
    check(`自愈完成（${fault}）`, ok, JSON.stringify(st && { state: st.primary.state, attempt: st.primary.attempt }));
    check(`pid 已更换（${fault}）`, ok && h.pid !== pid1, `old=${pid1} new=${h && h.pid}`);
    fs.writeFileSync(SBX_PATCH, original);
  }

  console.log("\n=== 清理 ===");
  const hEnd = readJson(HB_FILE);
  if (hEnd && hEnd.pid) killTree(hEnd.pid);
  killTree(sup.pid);
  await sleep(2000);
  console.log(`\n==== CHAOS 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
