"use strict";
/**
 * 沙箱演练 P2：卫星实例心跳 / L3 自检 degraded 上报 / dump-config 冒烟。
 * 安全边界：只改 profiles/sbx/cordis.patch.yml（沙箱），绝不碰 profiles/web。
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const BIN = "C:/Users/cxm20/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const STATE = "C:/Users/cxm20/.dsh/binary-star-sbx";
const HB_FILE = `${STATE}/heartbeat/satellite.json`;
const SBX_PATCH = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function alive(pid) { return pid ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)) : false; }

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  const pre = readJson(HB_FILE);
  if (pre && pre.pid && alive(pre.pid)) killTree(pre.pid);
  for (const f of [HB_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }

  console.log("=== A: 卫星实例 ===");
  const sat = spawn(process.execPath, [BIN, "--profile", "satellite", "--port", "3181"], {
    cwd: "D:/DSH/.binary-star/sat-workspace",
    env: {
      ...process.env,
      DSH_BINARY_ROLE: "satellite",
      DSH_BINARY_STATE: STATE,
      DSH_BINARY_TOKEN: "p2-test-token",
      DSH_BINARY_HEARTBEAT_MS: "1000",
      DSH_BINARY_SELFCHECK_MS: "2000",
      DSH_BINARY_SELFCHECK_PATCH: "profiles/sbx/cordis.patch.yml",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  sat.stderr.on("data", (d) => { if (String(d).includes("Error")) process.stdout.write(`[sat:err] ${String(d).trim()}\n`); });

  let h = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    h = readJson(HB_FILE);
    if (h && h.role === "satellite" && h.health === "ok") break;
  }
  check("卫星心跳出现（role=satellite, health=ok）", h && h.role === "satellite" && h.health === "ok", JSON.stringify(h));
  check("卫星心跳 token 正确", h && h.token === "p2-test-token");
  check("卫星进程存活", sat.exitCode === null && h && alive(h.pid));

  console.log("\n=== B: L3 自检（改坏 sbx patch → degraded → 还原）===");
  const original = fs.readFileSync(SBX_PATCH, "utf8");
  const broken = original.replace(/^\s*- id:\s*binary-star-host\s*$/m, "  - no-id-here");
  check("构造坏 patch（去掉 - id:）", broken !== original && !/^\s*- id:/m.test(broken));
  fs.writeFileSync(SBX_PATCH, broken);

  h = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    h = readJson(HB_FILE);
    if (h && h.health === "degraded") break;
  }
  check("心跳 health=degraded（自检发现）", h && h.health === "degraded", JSON.stringify(h && { health: h.health, detail: h.detail }));
  check("degraded 带原因", h && h.detail && h.detail.includes("insert"), h && h.detail);

  fs.writeFileSync(SBX_PATCH, original);
  h = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    h = readJson(HB_FILE);
    if (h && h.health === "ok") break;
  }
  check("还原后心跳恢复 ok", h && h.health === "ok", JSON.stringify(h && h.health));

  console.log("\n=== C: --dump-config 冒烟 ===");
  const runDump = () => spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: "D:/DSH/.binary-star/sbx-workspace",
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(SBX_PATCH, original + "\n- insert: [\n    - id: broken\n");
  const bad = runDump();
  check("坏 patch 时 dump-config 非零退出（能发现故障）", bad.status !== 0, `status=${bad.status}`);
  fs.writeFileSync(SBX_PATCH, original);
  const good = runDump();
  check("好 patch 时 dump-config 零退出", good.status === 0, `status=${good.status}`);

  console.log("\n=== 清理 ===");
  if (h && h.pid) killTree(h.pid);
  killTree(sat.pid);
  await sleep(2000);
  const hEnd = readJson(HB_FILE);
  check("清理后无存活残留", !hEnd || !hEnd.pid || !alive(hEnd.pid));

  console.log(`\n==== P2 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
