"use strict";
/**
 * P2 验证 B：受控自重启验证 + 自我修改协议 CLI。
 *  A) 账本 CLI 回路：journal open（自动备份）→ 修改 → commit → 再修改 → rollback → 还原
 *  B) 受控自重启（成功）：健康主星收到 restart-request → 重启 → 探针通过 → 请求清除
 *  C) 受控自重启（失败→阶梯回滚）：open 账目 + 坏 patch → restart-request → 重启失败
 *     → 阶梯第 2 步回滚 open 账目 → 恢复 → 请求清除
 *
 * 安全边界：只改 profiles/sbx/cordis.patch.yml 与沙箱状态目录。
 *
 * 本脚本不含硬编码绝对路径：以下常量均在运行时推导（也可用环境变量覆盖）：
 *   DSH_BIN / DSH_SBX_CONFIG / DSH_SBX_STATE / DSH_SBX_PATCH / DSH_SBX_WORKSPACE
 * 用法: node scripts/drill-p2b.js
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir().replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const SBX_ROOT = process.env.DSH_SBX_ROOT || path.join(ROOT, "..", ".binary-star").replace(/\\/g, "/");
const BIN = process.env.DSH_BIN || path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js").replace(/\\/g, "/");
const SANDBOX_CONFIG = process.env.DSH_SBX_CONFIG || path.join(SBX_ROOT, "config.sandbox.json").replace(/\\/g, "/");
const STATE = process.env.DSH_SBX_STATE || path.join(HOME, ".dsh", "binary-star-sbx").replace(/\\/g, "/");
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const CTRL_DIR = `${STATE}/control`;
const REQ_FILE = `${CTRL_DIR}/restart-request.json`;
const SBX_PATCH = process.env.DSH_SBX_PATCH || path.join(HOME, ".dsh", "profiles", "sbx", "cordis.patch.yml").replace(/\\/g, "/");
const SBX_WORKSPACE = process.env.DSH_SBX_WORKSPACE || path.join(SBX_ROOT, "sbx-workspace").replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function readJournal(f) {
  // journal 是 JSONL（每行一条），不是单个 JSON
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  } catch { return []; }
}
function runCli(args) {
  const r = spawnSync(process.execPath, ["src/cli.js", ...args], {
    cwd: ROOT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
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

  // ── 干净起跑 ──────────────────────────────────────────
  for (const f of [STATE_FILE, HB_FILE, REQ_FILE, `${STATE}/locks/supervisor.lock`, `${STATE}/journal.jsonl`, `${REQ_FILE}.failed`]) { try { fs.rmSync(f, { force: true }); } catch {} }
  // 清空账本备份目录（pre-*）与日志，保证备份内容是最新的
  for (const sub of ["snapshots", "logs"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && spawnSync("tasklist", ["/FI", `PID eq ${pre.pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pre.pid))) killTree(pre.pid);

  // 预检：sbx 配置必须可解析（防止上轮演练残留的坏 patch 静默污染本场）
  const preflight = spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: SBX_WORKSPACE, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (preflight.status !== 0) {
    console.error("[drill] 预检失败: sbx 配置不可解析（dump-config 非零）。请先修复 profiles/sbx/cordis.patch.yml 再运行。");
    process.exit(2);
  }
  console.log("[drill] 预检通过: sbx 配置可解析");
  const drillStart = Date.now();
  const original = fs.readFileSync(SBX_PATCH, "utf8");

  // ── A: 账本 CLI 回路 ──────────────────────────────────
  console.log("=== A: 账本 CLI 回路 ===");
  const openR = runCli(["journal", "open", "--desc", "p2b 演练", "--scope", "profiles/sbx/cordis.patch.yml"]);
  const jid = (openR.out.match(/账目 (J-\d+) 已开启/) || [])[1];
  check("journal open 成功（返回账目 id）", !!jid && openR.code === 0, openR.out);
  fs.appendFileSync(SBX_PATCH, "\n# p2b: 第一次修改\n");
  const commitR = runCli(["journal", "commit", jid]);
  check("journal commit 成功", commitR.code === 0 && commitR.out.includes("已提交"), commitR.out);
  fs.appendFileSync(SBX_PATCH, "\n# p2b: 第二次修改（模拟后续破坏）\n");
  const rollR = runCli(["journal", "rollback", jid]);
  check("journal rollback 成功", rollR.code === 0 && rollR.out.includes("已回滚"), rollR.out);
  check("rollback 还原到原始内容", fs.readFileSync(SBX_PATCH, "utf8") === original);

  // ── 启动监督者 ────────────────────────────────────────
  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: ROOT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
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

  // ── B: 受控自重启（成功路径）──────────────────────────
  console.log("\n=== B: 受控自重启（成功）===");
  fs.mkdirSync(CTRL_DIR, { recursive: true });
  fs.writeFileSync(REQ_FILE, JSON.stringify({ journalEntryId: jid, desc: "p2b: 受控自重启演练", ts: new Date().toISOString() }));
  const reqTime = Date.now();
  let h2 = null, st2 = null, reqGone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    h2 = readJson(HB_FILE);
    st2 = readJson(STATE_FILE);
    reqGone = !fs.existsSync(REQ_FILE);
    if (reqGone && st2 && st2.primary.state === "RUNNING" && new Date(st2.primary.since).getTime() >= reqTime &&
        h2 && h2.health === "ok" && h2.pid !== pid1) break;
  }
  check("受控重启后心跳 PID 变化", h2 && h2.pid !== pid1, `old=${pid1} new=${h2 && h2.pid}`);
  check("restart-request 已被消费清除", reqGone);
  check("状态回到 RUNNING", st2 && st2.primary.state === "RUNNING", st2 && st2.primary.state);

  // ── C: 受控自重启（失败 → 阶梯回滚 open 账目）─────────
  console.log("\n=== C: 受控自重启（失败 → 阶梯回滚）===");
  const openR2 = runCli(["journal", "open", "--desc", "p2b: 改坏 patch", "--scope", "profiles/sbx/cordis.patch.yml"]);
  const jid2 = (openR2.out.match(/账目 (J-\d+) 已开启/) || [])[1];
  check("open 账目 J2 成功", !!jid2, openR2.out);
  fs.writeFileSync(SBX_PATCH, original + "\n- insert: [\n    - id: broken\n");
  // 确认破坏真实有效：dump-config 必须失败
  const badDump = spawnSync(process.execPath, [BIN, "--profile", "sbx", "--dump-config"], {
    cwd: SBX_WORKSPACE, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  check("坏 patch 已写入且 dump-config 失败", badDump.status !== 0, `status=${badDump.status}`);
  fs.writeFileSync(REQ_FILE, JSON.stringify({ journalEntryId: jid2, desc: "p2b: 故意改坏后请求重启验证", ts: new Date().toISOString() }));
  const reqTime2 = Date.now();
  const pid2 = h2 && h2.pid;
  let h3 = null, st3 = null, reqGone2 = false;
  for (let i = 0; i < 60; i++) { // 阶梯最多 ~4 次重启 × 50s，给足 300s
    await sleep(5000);
    h3 = readJson(HB_FILE);
    st3 = readJson(STATE_FILE);
    reqGone2 = !fs.existsSync(REQ_FILE);
    if (reqGone2 && st3 && st3.primary.state === "RUNNING" && new Date(st3.primary.since).getTime() >= reqTime2 &&
        h3 && h3.health === "ok" && h3.pid !== pid2) break;
  }
  check("阶梯回滚后主星恢复", st3 && st3.primary.state === "RUNNING" && h3 && h3.health === "ok", JSON.stringify(st3 && st3.primary));
  check("坏 patch 已被回滚还原", fs.readFileSync(SBX_PATCH, "utf8") === original);
  check("请求已清除", reqGone2);
  const j2entry = readJournal(`${STATE}/journal.jsonl`).find((x) => x.id === jid2);
  check("账目 J2 已标记 reverted", j2entry && j2entry.status === "reverted", j2entry && j2entry.status);

  // ── 清理 ──────────────────────────────────────────────
  console.log("\n=== 清理 ===");
  if (h3 && h3.pid) killTree(h3.pid);
  killTree(sup.pid);
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    const hx = readJson(HB_FILE);
    if (!hx || !hx.pid || !spawnSync("tasklist", ["/FI", `PID eq ${hx.pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(hx.pid))) break;
    killTree(hx.pid);
  }
  const hEnd = readJson(HB_FILE);
  check("清理后无存活残留", !hEnd || !hEnd.pid || !spawnSync("tasklist", ["/FI", `PID eq ${hEnd.pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(hEnd.pid)));

  console.log(`\n==== P2B 验证结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[drill] 异常:", e); process.exit(2); });
