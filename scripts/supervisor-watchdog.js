"use strict";
/**
 * 监督者守护进程（supervisor watchdog）：CLI 模式下的"监督者的监督者"。
 *
 * 背景（2026-08-26 事故）：监督者被误杀（如 agent 自修复时 taskkill /T 误杀
 * 进程树）后，双星系统彻底失明——没有任何组件会自动拉起监督者。桌面壳看门狗
 * 只覆盖"壳自己拉起的监督者"，纯 CLI 模式没有守护。
 *
 * 本脚本：循环拉起 `cli.js start`，监督者进程意外退出（崩溃/被杀）后延迟重启，
 * 记录重启日志。配合系统的单实例锁，不会与已有监督者冲突。
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

function runSupervisor() {
  log(`拉起监督者: ${CLI}`);
  const child = spawn(process.execPath, [CLI, "start"], {
    cwd: ROOT,
    env: { ...process.env, DSH_BINARY_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => log(`[supervisor] ${String(d).trim().slice(0, 200)}`));
  child.stderr.on("data", (d) => log(`[supervisor:err] ${String(d).trim().slice(0, 200)}`));
  child.on("exit", (code, sig) => {
    if (stopping) return;
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

process.on("SIGINT", () => { stopping = true; process.exit(0); });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });

log(`监督者守护启动（interval=${intervalSec}s maxRestarts=${maxRestarts} log=${logFile}）`);
runSupervisor();
