"use strict";
/**
 * P5 上线脚本：把 binary-star 宿主插件挂进目标 profile。
 * ⚠️ 默认目标为真实 web profile（会修改真实部署）——仅在批准后运行。
 * 可用环境变量指定其他目标（用于彩排）：DSH_DEPLOY_PATCH / DSH_DEPLOY_NM /
 * DSH_DEPLOY_PROFILE / DSH_DEPLOY_CWD / DSH_DEPLOY_BIN / DSH_DEPLOY_STATE。
 *
 * 本脚本不含硬编码绝对路径：默认值均在运行时推导
 * （HOME = 用户主目录；BIN = npm 全局目录下的 dsh bin.js；PLUGIN = 本仓库 plugin/），
 * 请确认推导结果与你部署环境一致，或用 DSH_DEPLOY_* 覆盖。
 *
 * 用法: node scripts/deploy-live.js
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const HOME = os.homedir();
const PATCH = process.env.DSH_DEPLOY_PATCH || path.join(HOME, ".dsh", "profiles", "web", "cordis.patch.yml");
const WEB_NM = process.env.DSH_DEPLOY_NM || path.join(HOME, ".dsh", "profiles", "web", "node_modules");
const PROFILE = process.env.DSH_DEPLOY_PROFILE || "web";
const CWD = process.env.DSH_DEPLOY_CWD || process.cwd();
const BIN = process.env.DSH_DEPLOY_BIN || path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const STATE = process.env.DSH_DEPLOY_STATE || path.join(HOME, ".dsh", "binary-star");
const JUNCTION = path.join(WEB_NM, "dsh-binary-star-host");
const PLUGIN = path.join(__dirname, "..", "plugin");
const ROW = "\n# ── binary-star 宿主插件（双星系统：心跳/自检）──\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";

function runDump() {
  return spawnSync(process.execPath, [BIN, "--profile", PROFILE, "--dump-config"], {
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
if (base.status !== 0) { console.error(`预检失败：profile "${PROFILE}" 组合树不可解析，先修复再上线`); process.exit(2); }
if (hasRow()) { console.error("已上线过（patch 含 binary-star-host），退出"); process.exit(0); }
console.log("[1/5] 预检通过：基线组合树健康");

// 2) 备份
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(STATE, "backup", `pre-live-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(PATCH, path.join(backupDir, "cordis.patch.yml"));
console.log(`[2/5] 已备份 cordis.patch.yml → ${backupDir}`);

// 3) junction（幂等；PowerShell New-Item 在本环境验证可用，cmd mklink 不稳定）
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

console.log("\n=== 上线完成 ===");
console.log("生效方式：配置 HMR 可能已实时生效；若心跳文件未出现，需重启主星一次。");
console.log("验证：  node src/cli.js status （在项目根运行）");
console.log("回滚：  copy \"" + path.join(backupDir, "cordis.patch.yml") + "\" \"" + PATCH + "\"");
console.log("        rmdir \"" + JUNCTION + "\"");
console.log("基线快照：node src/cli.js snapshot baseline （在项目根运行）");
