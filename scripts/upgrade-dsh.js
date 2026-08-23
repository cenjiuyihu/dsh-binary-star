"use strict";
/**
 * dsh 版本升级脚本（一次命令完成升级 + 验证，失败自动回滚到旧版本）。
 *
 * 流程：
 *   1. 暂停自动修复（halt）+ 升级前快照（baseline-pre-upgrade）
 *   2. npm install -g @deepseek-ai/dsh@<目标版本>
 *   3. 重跑 ui-patch（若存在本地定制脚本；anchor 失配仅警告，不阻塞核心验证）
 *   4. --dump-config 冒烟 → 失败则回滚 npm 包并退出
 *   5. journal open + 受控自重启（restart-request.json）→ 探针验证
 *   6. 受控重启失败（.failed）→ 回滚 npm 包 → 重新受控重启
 *   7. verify-live 验收 → journal commit
 *
 * 任何一步失败都会尝试恢复：恢复 halt 状态、回滚到旧版本、恢复原主星。
 *
 * 用法: node scripts/upgrade-dsh.js <目标版本> [--keep-halt]
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, "..");
const CONFIG = process.env.DSH_BINARY_CONFIG || path.join(ROOT, "config.default.json");
const DSH_HOME = process.env.DSH_BINARY_DSH_HOME || path.join(HOME, ".dsh");
const STATE = process.env.DSH_BINARY_STATE || path.join(DSH_HOME, "binary-star");
const VERIFY = path.join(ROOT, "scripts", "verify-live.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8", windowsHide: true, timeout: opts.timeout || 120000,
    stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd,
  });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
function npmInstall(version) {
  const comSpec = process.env.ComSpec || "cmd.exe";
  return run(comSpec, ["/c", `npm.cmd install -g @deepseek-ai/dsh@${version} --loglevel=warn`], { timeout: 360000 });
}
function dshVersion() {
  const cfg = readJsonSafe(CONFIG);
  const pkg = cfg && cfg.dshPkg ? path.join(cfg.dshPkg, "package.json") : "";
  const p = pkg && fs.existsSync(pkg) ? readJsonSafe(pkg) : null;
  return p ? p.version : "unknown";
}
function dumpConfig() {
  const cfg = readJsonSafe(CONFIG);
  const bin = cfg && cfg.dshPkg ? path.join(cfg.dshPkg, "lib", "bin.js") : "";
  if (!bin || !fs.existsSync(bin)) return { code: -1, out: "", err: "bin.js 不存在" };
  return run(process.execPath, [bin, "--profile", cfg.primaryProfile || "web", "--dump-config"], { timeout: 60000, cwd: cfg.primaryWorkdir });
}
function journal(sub, ...rest) {
  return run(process.execPath, [path.join(ROOT, "src", "cli.js"), "journal", sub, ...rest], { timeout: 30000 });
}
function writeHalt(on) {
  const f = path.join(STATE, "control", "halt");
  try {
    if (on) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString()); }
    else fs.rmSync(f, { force: true });
    return true;
  } catch { return false; }
}
function runPatch() {
  // ui-patch 脚本优先取环境变量，其次取配置的 uiPatch.script（均不含硬编码路径）
  const cfg0 = readJsonSafe(CONFIG);
  const script = process.env.DSH_UPGRADE_PATCH || (cfg0 && cfg0.uiPatch && cfg0.uiPatch.script) || "";
  if (!script || !fs.existsSync(script)) return { ok: true, note: "无 ui-patch 脚本（跳过）" };
  const r = run(process.execPath, [script], { timeout: 60000 });
  return { ok: r.code === 0, out: r.out, err: r.err };
}
async function controlledRestart(desc, timeoutMs = 240000) {
  // journal open → 写 restart-request → 轮询请求文件消失
  const open = journal("open", "--desc", desc);
  const m = /账目 (J-\d+) 已开启/.exec(open.out);
  const jid = m && m[1];
  if (!jid) return { ok: false, error: `journal open 失败: ${open.out}` };
  const reqFile = path.join(STATE, "control", "restart-request.json");
  fs.writeFileSync(reqFile, JSON.stringify({ journalEntryId: jid, desc, ts: new Date().toISOString() }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    if (!fs.existsSync(reqFile)) return { ok: true, jid };
    if (fs.existsSync(`${reqFile}.failed`)) return { ok: false, jid, error: "受控重启失败×3（.failed）" };
  }
  return { ok: false, jid, error: "受控重启超时（请求文件未消费）" };
}
function verifyLive() {
  const r = run(process.execPath, [VERIFY], { timeout: 120000 });
  const pass = (r.out.match(/PASS/g) || []).length;
  const fail = (r.out.match(/FAIL/g) || []).length;
  return { ok: fail === 0, pass, fail, out: r.out };
}

async function main() {
  const target = process.argv[2];
  if (!target) { console.error("用法: node scripts/upgrade-dsh.js <目标版本> [--keep-halt]"); process.exit(2); }
  const keepHalt = process.argv.includes("--keep-halt");
  const oldVersion = dshVersion();
  console.log(`=== dsh 升级: ${oldVersion} → ${target} ===`);
  if (oldVersion === target) { console.log("已经是目标版本，无需升级"); process.exit(0); }

  // 1) 安全闸
  writeHalt(true);
  run(process.execPath, [path.join(ROOT, "src", "cli.js"), "snapshot", "baseline-pre-upgrade"], { timeout: 60000 });
  console.log("[1/7] halt + 快照 baseline-pre-upgrade 完成");

  // 2) 升级 npm 包
  const ins = npmInstall(target);
  if (ins.code !== 0) {
    console.error(`[!] npm install 失败:\n${ins.err || ins.out}`);
    console.error(`[!] 尝试回滚到 ${oldVersion}...`);
    npmInstall(oldVersion);
    writeHalt(!keepHalt);
    process.exit(1);
  }
  console.log(`[2/7] npm 安装 ${target} 完成`);

  // 3) ui-patch
  const patch = runPatch();
  if (!patch.ok) console.warn(`[!] ui-patch 有 anchor 失配（${patch.err.trim().split("\n")[0]}）——需要按新版本更新补丁，但不阻塞核心验证`);
  else console.log(`[3/7] ui-patch: ${patch.note || "通过"}`);

  // 4) 冒烟
  const smoke = dumpConfig();
  if (smoke.code !== 0) {
    console.error(`[!] dump-config 冒烟失败（code=${smoke.code}）：${smoke.err.trim().slice(0, 300)}`);
    console.error(`[!] 回滚到 ${oldVersion}...`);
    npmInstall(oldVersion);
    runPatch();
    console.error("[!] 已回滚。请人工检查配置兼容性后重试。");
    writeHalt(!keepHalt);
    process.exit(1);
  }
  console.log("[4/7] dump-config 冒烟通过");

  // 5) 受控重启验证
  console.log("[5/7] 受控自重启（主星将短暂中断，探针自动验证）...");
  let cr = await controlledRestart(`dsh ${oldVersion} → ${target} 升级验证`);
  if (!cr.ok) {
    console.error(`[!] 受控重启失败（${cr.error}），回滚到 ${oldVersion}...`);
    npmInstall(oldVersion);
    runPatch();
    console.log("[!] 已回滚 npm 包，重新受控重启...");
    cr = await controlledRestart(`dsh 升级回滚到 ${oldVersion} 验证`);
    if (!cr.ok) { console.error(`[!] 回滚后重启仍失败: ${cr.error} —— 请人工介入`); process.exit(1); }
  }

  // 6) 验收
  const v = verifyLive();
  console.log(`[6/7] verify-live: ${v.pass} PASS / ${v.fail} FAIL`);
  if (!v.ok) { console.error("[!] 验收失败——请检查上方输出，必要时人工回滚"); process.exit(1); }

  // 7) 收尾
  journal("commit", cr.jid);
  writeHalt(!keepHalt);
  console.log(`[7/7] 完成 ✅ dsh ${oldVersion} → ${target} 升级成功（账目 ${cr.jid} 已提交）`);
  process.exit(0);
}

main().catch((e) => { console.error("[upgrade] 异常:", e); process.exit(2); });
