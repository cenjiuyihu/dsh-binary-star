"use strict";
/**
 * 监督者守护开机自启安装/卸载工具。
 *
 * 机制：在用户启动文件夹（shell:startup）创建 dsh-binary-watchdog.vbs——
 * 登录时以隐藏窗口（0 = 隐藏）运行 supervisor-watchdog.js，实现
 * "开机自启的常驻守护"，不依附壳、无需管理员权限。
 *
 * 与已有监督者的衔接：watchdog 启动时会检测 supervisor.lock——
 * 已有监督者在运行则进入监视模式（不重复拉起），待其退出后接管。
 *
 * 用法:
 *   node scripts/install-autostart.js          # 安装（幂等，可重复运行）
 *   node scripts/install-autostart.js --uninstall  # 卸载
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const WATCHDOG = path.join(ROOT, "scripts", "supervisor-watchdog.js");
const NODE = process.execPath; // 当前 node 可执行文件（自启时仍有效）
const STARTUP_DIR = path.join(
  os.homedir(),
  "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
);
const VBS = path.join(STARTUP_DIR, "dsh-binary-watchdog.vbs");

// VBS：隐藏窗口直接运行 node（ws.Run 的命令串中 "" 转义内层引号）
function vbsContent() {
  const cmd = `"${NODE}" "${WATCHDOG}"`;
  return [
    'Set ws = CreateObject("WScript.Shell")',
    `ws.Run "${cmd.replace(/"/g, '""')}", 0, False`,
    "",
  ].join("\r\n");
}

const uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  if (fs.existsSync(VBS)) {
    fs.rmSync(VBS, { force: true });
    console.log(`已卸载开机自启：${VBS}`);
  } else {
    console.log("未安装过开机自启（无需卸载）");
  }
  process.exit(0);
}

if (!fs.existsSync(WATCHDOG)) {
  console.error(`[!] watchdog 脚本不存在: ${WATCHDOG}`);
  process.exit(1);
}

fs.mkdirSync(STARTUP_DIR, { recursive: true });
fs.writeFileSync(VBS, vbsContent(), "utf8");
console.log(`✅ 开机自启已安装：${VBS}`);
console.log(`   登录时将隐藏窗口运行: ${NODE} ${WATCHDOG}`);
console.log(`   卸载：node scripts/install-autostart.js --uninstall`);
console.log("   说明：watchdog 常驻守护监督者；`dsh-binary stop` 可同时停止监督者与守护。");
