"use strict";
/**
 * 监督者守护进程（supervisor watchdog）：CLI 模式下的"监督者的监督者"。
 *
 * 背景（2026-08-26 事故）：监督者被误杀（如 agent 自修复时 taskkill /T 误杀
 * 进程树）后，双星系统彻底失明——没有任何组件会自动拉起监督者。桌面壳看门狗
 * 只覆盖"壳自己拉起的监督者"，纯 CLI 模式没有守护。
 *
 * 使用语义（手动常驻，不依附壳）：
 *   - 启动：`node scripts/supervisor-watchdog.js` —— 常驻运行，监督者崩溃后自动重启
 *   - 关闭：`dsh-binary stop`（受控停止感知：检测 control/shutdown 后随监督者退出）
 *     或 Ctrl+C / SIGTERM
 *   - 崩溃重启：监督者意外退出（非受控停止）→ 延迟 interval 秒后自动拉起
 *
 * 用法:
 *   node scripts/supervisor-watchdog.js [--interval 5] [--log <file>] [--max-restarts N]
 * 建议配合 Windows 任务计划（开机自启 + 失败重启）或桌面壳使用。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "src", "cli.js");
const STATE = process.env.DSH_BINARY_STATE || path.join(os.homedir(), ".dsh", "binary-star");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const intervalSec = Math.max(2, Number(arg("--interval", "5")));
const maxRestarts = Number(arg("--max-restarts", "0")); // 0 = 无限
const logFile = arg("--log", path.join(STATE, "logs", "watchdog.log"));

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, s + "\n");
  } catch {}
  console.log(s);
}

let restarts = 0;
let stopping = false;
let shutdownSeen = false; // 受控停止感知:检测 control/shutdown → 不重启,随监督者退出
let currentChild = null; // 当前由本守护拉起的监督者进程(监视模式下为空)

// 检测是否已有监督者在运行(锁文件 + pid 存活)
function supervisorExists() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(STATE, "locks", "supervisor.lock"), "utf8"));
    if (!lock || !lock.pid) return false;
    try { process.kill(lock.pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  } catch { return false; }
}

// 监视 control/shutdown(受控停止感知):
// 用户执行 `dsh-binary stop` 时写入该文件 → 监督者消费并退出;
// watchdog 看到后进入停止模式,不再重启监督者,一起退出——保证
// "手动启动常驻,直到手动关闭"的语义(崩溃自动重启,手动停止不重启)。
const CONTROL_DIR = path.join(STATE, "control");
const SHUTDOWN_FILE = path.join(CONTROL_DIR, "shutdown");
const shutdownWatch = setInterval(() => {
  if (fs.existsSync(SHUTDOWN_FILE)) {
    shutdownSeen = true;
    log("检测到 control/shutdown（受控停止），守护进程随监督者一起退出，不再重启");
    clearInterval(shutdownWatch);
    if (!currentChild) process.exit(0); // 监视模式(无子进程)下直接退出
  }
}, 2000);

function runSupervisor() {
  log(`拉起监督者: ${CLI}`);
  const child = spawn(process.execPath, [CLI, "start"], {
    cwd: ROOT,
    env: { ...process.env, DSH_BINARY_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  currentChild = child;
  child.stdout.on("data", (d) => log(`[supervisor] ${String(d).trim().slice(0, 200)}`));
  child.stderr.on("data", (d) => log(`[supervisor:err] ${String(d).trim().slice(0, 200)}`));
  child.on("exit", (code, sig) => {
    currentChild = null;
    if (stopping || shutdownSeen) {
      log("守护进程退出（受控停止或收到信号）");
      process.exit(0);
    }
    restarts += 1;
    log(`监督者退出 code=${code} sig=${sig}（第 ${restarts} 次重启）`);
    if (maxRestarts > 0 && restarts > maxRestarts) {
      log(`达到重启上限 ${maxRestarts}，守护进程退出（需人工介入）`);
      process.exit(1);
    }
    // 延迟重启（等端口/锁释放，也防崩溃风暴）
    setTimeout(runSupervisor, intervalSec * 1000);
  });
  return child;
}

// 启动：若已有监督者在运行（如手动启动、桌面壳拉起、上次遗留），
// 转为监视模式——不重复拉起，待其退出后由本守护接管。
// 否则直接拉起。
function waitForExistingSupervisorGone() {
  setTimeout(() => {
    if (supervisorExists()) {
      waitForExistingSupervisorGone();
    } else {
      log("已有监督者已退出，由本守护接管拉起");
      runSupervisor();
    }
  }, 3000);
}

process.on("SIGINT", () => { stopping = true; process.exit(0); });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });

log(`监督者守护启动（interval=${intervalSec}s maxRestarts=${maxRestarts} log=${logFile}）`);
if (supervisorExists()) {
  log("检测到已有监督者在运行，进入监视模式（待其退出后由本守护接管）");
  waitForExistingSupervisorGone();
} else {
  runSupervisor();
}
