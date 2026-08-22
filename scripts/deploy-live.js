"use strict";
/**
 * 部署脚本：把 binary-star 宿主插件挂进目标 profile。
 * ⚠️ 默认目标为真实 web profile（会修改真实部署）——仅在确认后运行。
 * 可用环境变量指定其他目标（用于彩排）：DSH_DEPLOY_PATCH / DSH_DEPLOY_NM /
 * DSH_DEPLOY_PROFILE / DSH_DEPLOY_CWD / DSH_DEPLOY_BIN / DSH_DEPLOY_STATE。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PATCH = process.env.DSH_DEPLOY_PATCH || path.join(DSH_HOME, "profiles/web/cordis.patch.yml");
const WEB_NM = process.env.DSH_DEPLOY_NM || path.join(DSH_HOME, "profiles/web/node_modules");
const PROFILE = process.env.DSH_DEPLOY_PROFILE || "web";
const CWD = process.env.DSH_DEPLOY_CWD || "D:/DSH";
const BIN = process.env.DSH_DEPLOY_BIN || ""; // 留空则从 $NPM_ROOT 推导
const STATE = process.env.DSH_DEPLOY_STATE || path.join(DSH_HOME, "binary-star");
const JUNCTION = path.join(WEB_NM, "dsh-binary-star-host");
const PLUGIN = path.join(__dirname, "..", "plugin");
const ROW = "\n# binary-star 宿主插件（双星系统：心跳/自检）\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";

function resolveBin() {
  if (BIN) return BIN;
  const comSpec = process.env.ComSpec || "cmd.exe";
  const r = spawnSync(comSpec, ["/c", "npm.cmd root -g"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const root = r.status === 0 ? String(r.stdout || "").trim().split(/\r?\n/)[0] : "";
  return root ? path.join(root, "@deepseek-ai", "dsh", "lib", "bin.js") : "";
}

function runDump() {
  const bin = resolveBin();
  if (!bin) return { status: -1 };
  return spawnSync(process.execPath, [bin, "--profile", PROFILE, "--dump-config"], {
    cwd: CWD, encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
  });
}
function hasRow() {
  const text = fs.readFileSync(PATCH, "utf8");
  return text.includes("binary-star-host");
}

console.log(`=== 双星系统部署（目标 profile: ${PROFILE}）===`);

// 1) 预检
const base = runDump();
if (base.status !== 0) { console.error(`预检失败：profile "${PROFILE}" 组合树不可解析，先修复再部署`); process.exit(2); }
if (hasRow()) { console.error("已部署过（patch 含 binary-star-host），退出"); process.exit(0); }
console.log("[1/5] 预检通过：基线组合树健康");

// 2) 备份
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(STATE, "backup", `pre-live-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(PATCH, path.join(backupDir, "cordis.patch.yml"));
console.log(`[2/5] 已备份 cordis.patch.yml → ${backupDir}`);

// 3) junction（幂等）
if (!fs.existsSync(JUNCTION)) {
  const r = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `New-Item -ItemType Junction -Path "${JUNCTION}" -Target "${PLUGIN}" -Force | Out-Null`,
  ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) { console.error(`junction 创建失败: ${String(r.stderr || r.stdout).trim()}`); process.exit(1); }
}
if (!fs.existsSync(path.join(JUNCTION, "package.json"))) { console.error("junction 创建失败"); process.exit(1); }
console.log("[3/5] node_modules junction 就绪");

// 4) 追加 patch 行
fs.appendFileSync(PATCH, ROW);
console.log("[4/5] 已追加 binary-star-host 行");

// 5) 验证
const after = runDump();
if (after.status !== 0) {
  console.error("验证失败：组合树不可解析——立即回滚（见下方命令）");
  console.log(`   copy "${path.join(backupDir, "cordis.patch.yml")}" "${PATCH}"`);
  process.exit(1);
}
console.log("[5/5] 验证通过：组合树健康（含 binary-star-host）");

console.log("\n=== 部署完成 ===");
console.log("生效方式：配置 HMR 可能已实时生效；若心跳文件未出现，需重启主星一次。");
console.log(`回滚：  copy "${path.join(backupDir, "cordis.patch.yml")}" "${PATCH}"`);
console.log(`        rmdir "${JUNCTION}"`);
console.log("基线快照：node src/cli.js snapshot baseline");
