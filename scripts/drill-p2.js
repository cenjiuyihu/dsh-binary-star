"use strict";
/**
 * P2 验证：
 *  A) 卫星实例启动 → satellite.json 心跳（role/token 正确）
 *  B) L3 自检：改坏 sbx patch → 心跳 health=degraded（无需崩溃）→ 还原 → 恢复 ok
 *  C) 阶梯第 1 步升级：`--dump-config` 冒烟对坏 patch 非零退出、好 patch 零退出
 *
 * 安全边界：只改 profiles/sbx/cordis.patch.yml（沙箱），绝不碰 profiles/web。
 *
 * 本脚本不含硬编码绝对路径：以下常量均在运行时推导（也可用环境变量覆盖）：
 *   DSH_BIN               dsh 的 bin.js 路径（默认 npm 全局目录，Windows 为 %USERPROFILE%\AppData\Roaming\npm）
 *   DSH_SBX_STATE         沙箱状态目录（默认 <HOME>/.dsh/binary-star-sbx）
 *   DSH_SBX_PATCH         沙箱 patch 文件（默认 <HOME>/.dsh/profiles/sbx/cordis.patch.yml）
 *   DSH_SBX_WORKSPACE     沙箱工作区（默认 <项目根>/../.binary-star/sbx-workspace）
 *   DSH_SBX_SAT_WORKSPACE 卫星工作区（默认 <项目根>/../.binary-star/sat-workspace）
 * 用法: node scripts/drill-p2.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir().replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const SBX_ROOT = process.env.DSH_SBX_ROOT || path.join(ROOT, "..", ".binary-star").replace(/\\/g, "/");
const BIN = process.env.DSH_BIN || path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js").replace(/\\/g, "/");
const STATE = process.env.DSH_SBX_STATE || path.join(HOME, ".dsh", "binary-star-sbx").replace(/\\/g, "/");
const HB_FILE = `${STATE}/heartbeat/satellite.json`;
const SBX_PATCH = process.env.DSH_SBX_PATCH || path.join(HOME, ".dsh", "profiles", "sbx", "cordis.patch.yml").replace(/\\/g, "/");
const SBX_WORKSPACE = process.env.DSH_SBX_WORKSPACE || path.join(SBX_ROOT, "sbx-workspace").replace(/\\/g, "/");
const SAT_WORKSPACE = process.env.DSH_SBX_SAT_WORKSPACE || path.join(SBX_ROOT, "sat-workspace").replace(/\\/g, "/");
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

  // 干净起跑
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && alive(pre.pid)) killTree(pre.pid);
  for (const f of [HB_FILE]) { try { fs.rmSync(f, { force: true }); } catch {} }

  // ── A: 卫星实例心跳 ────────────────────────────────────
  console.log("=== A: 卫星实例 ===");
  const sat = spawn(process.execPath, [BIN, "--profile", "satellite", "--port", "3181"], {
    cwd: SAT_WORKSPACE,
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

  // ── B: L3 自检降级 ─────────────────────────────────────
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

  // ── C: dump-config 冒烟（阶梯第 1 步升级）──────────────
  console.log("\n=== C: --dump-config 冒烟 ===");
  const runDump = () => spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: SBX_WORKSPACE,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 用例：真实语法损坏（YAML 未闭合列表）——加载器无法解析，dump-config 必须非零退出
  fs.writeFileSync(SBX_PATCH, original + "\n- insert: [\n    - id: broken\n");
  const bad = runDump();
  check("坏 patch 时 dump-config 非零退出（能发现故障）", bad.status !== 0, `status=${bad.status}`);
  fs.writeFileSync(SBX_PATCH, original);
  const good = runDump();
  check("好 patch 时 dump-config 零退出", good.status === 0, `status=${good.status}`);

  // 清理
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
