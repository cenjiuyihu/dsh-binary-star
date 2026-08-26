"use strict";
/**
 * 双星系统：路径解析与状态目录初始化（P1）。
 * 纯 Node 实现，零依赖。
 *
 * 可移植性：config 中的路径支持占位符（开源版默认配置使用）：
 *  - $HOME   → 用户主目录（os.homedir()）
 *  - $CWD    → 当前工作目录
 *  - $NPM_ROOT → npm 全局包根目录（npm root -g）
 * 本机配置使用具体路径，不受影响。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DEFAULT_CONFIG = path.join(__dirname, "..", "config.default.json");

/** 占位符展开 */
function expandPath(v) {
  if (typeof v !== "string") return v;
  const home = os.homedir().replace(/\\/g, "/");
  return v
    .replace(/\$HOME/g, home)
    .replace(/\$CWD/g, process.cwd().replace(/\\/g, "/"));
}

/** npm 全局根（$NPM_ROOT 解析用；.cmd 需经 cmd.exe 执行，ps1 被禁） */
function npmRoot() {
  const comSpec = process.env.ComSpec || "cmd.exe";
  for (const bin of ["npm.cmd", "npm"]) {
    try {
      const r = spawnSync(comSpec, ["/c", `${bin} root -g`], { encoding: "utf8", windowsHide: true, timeout: 20000 });
      if (r.status === 0 && r.stdout) {
        const p = String(r.stdout).trim().split(/\r?\n/)[0];
        if (p) return p;
      }
    } catch {}
  }
  return "";
}

/** 读取配置（支持 DSH_BINARY_CONFIG 覆盖；合并环境变量覆盖；展开占位符） */
function loadConfig() {
  const file = process.env.DSH_BINARY_CONFIG || DEFAULT_CONFIG;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.env.DSH_BINARY_STATE) cfg.stateDir = process.env.DSH_BINARY_STATE;
  if (process.env.DSH_BINARY_DSH_HOME) cfg.dshHome = process.env.DSH_BINARY_DSH_HOME;
  // 占位符展开（仅路径类字段）
  for (const k of ["dshHome", "stateDir", "primaryWorkdir", "satelliteWorkdir", "dshPkg"]) {
    if (typeof cfg[k] === "string") cfg[k] = expandPath(cfg[k]);
  }
  // $NPM_ROOT = npm 全局根；dshPkg 应为全局根下的 dsh 包目录（$NPM_ROOT/@deepseek-ai/dsh）
  if (typeof cfg.dshPkg === "string" && cfg.dshPkg.includes("$NPM_ROOT")) {
    const root = (npmRoot() || "").replace(/\\/g, "/");
    cfg.dshPkg = cfg.dshPkg.replace(/\$NPM_ROOT/g, root);
  }
  if (cfg.takeover && typeof cfg.takeover.sessionsRoot === "string") {
    cfg.takeover.sessionsRoot = expandPath(cfg.takeover.sessionsRoot);
  }
  if (cfg.uiPatch) {
    for (const k of ["script", "backup"]) {
      if (typeof cfg.uiPatch[k] === "string") cfg.uiPatch[k] = expandPath(cfg.uiPatch[k]);
    }
  }
  return cfg;
}

/** 状态目录及子目录集合 */
function statePaths(cfg) {
  const root = cfg.stateDir;
  return {
    root,
    heartbeat: path.join(root, "heartbeat"),
    journal: path.join(root, "journal.jsonl"),
    snapshots: path.join(root, "snapshots"),
    locks: path.join(root, "locks"),
    control: path.join(root, "control"),
    logs: path.join(root, "logs"),
    replica: path.join(root, "replica"),
    stateFile: path.join(root, "state.json"),
  };
}

/** 确保状态目录存在（幂等） */
function ensureStateDirs(cfg) {
  const p = statePaths(cfg);
  for (const dir of [
    p.root, p.heartbeat, p.snapshots, p.locks, p.control, p.logs, p.replica,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

/** dsh 主进程启动命令（来自 P0 审计：node <pkg>/lib/bin.js --profile <profile>） */
function primaryCommand(cfg) {
  const env = {
    ...process.env,
    DSH_BINARY_ROLE: "primary",
    DSH_BINARY_STATE: cfg.stateDir,
    DSH_BINARY_HEARTBEAT_MS: String(cfg.heartbeat.intervalMs || 5000),
  };
  // Win32 下监督者以无窗口方式（windowsHide）拉起主星 → dsh 原生目录选择器
  // （IFileOpenDialog 模态对话框）无法显示到交互桌面（前台激活限制）→ 25s 超时"按钮无响应"。
  // config.picker="browse" 时注入 SSH_CONNECTION 标志，让 dsh 的 auto 决策
  // （loopback + SSH → browse）改用页面内目录浏览。只影响监督者拉起的实例。
  if (cfg.picker === "browse") env.SSH_CONNECTION = "dsh-binary-star";
  return {
    cmd: process.execPath, // node
    args: [path.join(cfg.dshPkg, "lib", "bin.js"), "--profile", cfg.primaryProfile],
    cwd: cfg.primaryWorkdir,
    env,
  };
}

/** 卫星启动命令（web bundles 后必须显式指定端口，避免与主星 :3080 冲突） */
function satelliteCommand(cfg) {
  return {
    cmd: process.execPath,
    args: [
      path.join(cfg.dshPkg, "lib", "bin.js"),
      "--profile", cfg.satelliteProfile,
      "--port", String(cfg.satellitePort || 3081),
    ],
    cwd: cfg.satelliteWorkdir,
    env: {
      ...process.env,
      DSH_BINARY_ROLE: "satellite",
      DSH_BINARY_STATE: cfg.stateDir,
      DSH_BINARY_HEARTBEAT_MS: String(cfg.heartbeat.intervalMs || 5000),
    },
  };
}

/** 追加一行日志（带时间戳），供监督者与 CLI 共用 */
function log(statePaths_, role, line) {
  const file = path.join(statePaths_.logs, `${role || "supervisor"}.log`);
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  process.stdout.write(`[${role || "supervisor"}] ${line}\n`);
}

module.exports = { loadConfig, statePaths, ensureStateDirs, primaryCommand, satelliteCommand, log, DEFAULT_CONFIG };
