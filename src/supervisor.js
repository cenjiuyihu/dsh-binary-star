"use strict";
/**
 * 双星系统：监督者（三层架构的最外层，永不依赖 LLM）。
 * 职责：
 *  1. 拉起主星（与桌面壳同款命令：node <pkg>/lib/bin.js <profile>）
 *  2. 心跳监视 + 故障分类（D1 启动失败 / D2 功能性故障 / D3 挂死 / D4 降级）
 *  3. 快速路径：重启 + 探针验证（成功判据 = 探针通过，不只是进程活）
 *  4. 慢速路径：向卫星发接管信号 + 就地执行修复阶梯（P2 起由卫星协同）
 *  5. 自身被杀的兜底：由外层 .cmd 循环重启（见 README）
 *
 * 注意：本文件在主星/卫星进程内不加载；只由监督者 CLI 进程使用。
 */
const { spawn } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const hb = require("./heartbeat");
const probe = require("./probe");
const state = require("./state");
const ladder = require("./ladder");
const seed = require("./seed");

/** Windows 下杀进程树（node 的 kill 不杀子进程树） */
function killTree(pid) {
  if (!pid) return;
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  return r.status === 0;
}

/** 会话目录编码（与 dsh 会话存储一致）：D:\DSH → --D-DSH-- */
function encodeWorkspace(cwd) {
  return "--" + String(cwd).replace(/[\\/:]/g, "-") + "--";
}

class Supervisor {
  constructor(cfg, paths_, opts = {}) {
    this.cfg = cfg;
    this.paths = paths_;
    this.opts = opts; // { primaryOnly: true } 用于 P1 单星调试
    this.primaryProc = null;
    this.running = false;
    this.restartCount = { hourStart: Date.now(), count: 0 };
    // 归属 token：每次监督者启动生成，注入子进程 env；心跳必须携带它才算可信
    this.token = randomUUID();
    this.cfg.token = this.token;
    // 启动宽限只适用于"本监督者启动后从未健康起来过"的实例；
    // 因此这两个标志只在构造器初始化，绝不在每次 spawn 时重置
    this.bootedAt = Date.now();
    this.sawHealthyHeartbeat = false;
    this.bootExits = 0; // 宽限期内主星进程退出次数（启动即崩检测）
    this.pendingTakeover = null; // {since, classification}
    this.takeoverProc = null;
  }

  _log(line) {
    const { log } = require("./paths");
    log(this.paths, "supervisor", line);
  }

  _setState(role, s, detail) {
    const st = state.readState(this.paths.stateFile);
    state.setState(this.paths.stateFile, st, role, s, detail);
  }

  _readState() {
    return state.readState(this.paths.stateFile);
  }

  spawnPrimary() {
    const cmd = require("./paths").primaryCommand(this.cfg);
    cmd.env.DSH_BINARY_TOKEN = this.token;
    this._log(`拉起主星: ${cmd.cmd} ${cmd.args.join(" ")} (cwd=${cmd.cwd})`);
    const proc = spawn(cmd.cmd, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      windowsHide: true,
    });
    this.primaryProc = proc;
    proc.stdout.on("data", (d) => this._log(`[primary:out] ${String(d).trim().slice(0, 300)}`));
    proc.stderr.on("data", (d) => this._log(`[primary:err] ${String(d).trim().slice(0, 300)}`));
    proc.on("exit", (code, sig) => {
      this._log(`主星进程退出 code=${code} sig=${sig}`);
      if (!this.sawHealthyHeartbeat) this.bootExits++;
      // 只有"仍指向本进程"时才清引用——旧进程的退出不能误清新进程的引用
      if (this.primaryProc === proc) this.primaryProc = null;
    });
  }

  restartPrimary() {
    if (this.primaryProc) killTree(this.primaryProc.pid);
    this.spawnPrimary();
  }

  /**
   * 野生实例防护：若主星端口被非本监督者管理的进程占用（手动启动的 dsh、
   * 其他环境/其他盘的实例），先终止它——否则重启的主星必然 EADDRINUSE
   * 启动失败，且该错误会被 cordis 包装成"插件树加载失败（include）"误导诊断
   * （2026-08-26 事故：TRAE 部署的 E 盘 dsh 源码版抢占 :3080，导致受控重启
   * 连续失败、阶梯用尽、修复报告误判为配置问题）。
   */
  async clearForeignPortOwner() {
    try {
      const port = this.cfg.primaryPort || 3080;
      if (this.cfg.probe && this.cfg.probe.httpCheck === false) return;
      const portPid = this.findPidByPort(port);
      const ownPid = this.primaryProc && this.primaryProc.pid;
      if (portPid && portPid !== process.pid && portPid !== ownPid) {
        this._log(`发现 :${port} 被野生进程 pid=${portPid} 占用（非本监督者管理），终止之`);
        killTree(portPid);
        await sleep(3000);
      }
    } catch (e) {
      this._log(`clearForeignPortOwner 异常: ${e.message}`);
    }
  }

  /** 快速路径：重启 + 探针验证（成功判据=探针通过，且绑定新进程 pid） */
  async fastPath(classification) {
    this._log(`快速路径开始（${classification}），尝试 ${this.cfg.fastPath.restartAttempts} 次`);
    await this.clearForeignPortOwner();
    for (let i = 1; i <= this.cfg.fastPath.restartAttempts; i++) {
      this.restartPrimary();
      const newProc = this.primaryProc;
      await sleep(this.cfg.fastPath.verifyWaitMs || 30000);
      const p = await probe.probePrimary(this.cfg, this.paths, this.paths.stateFile, newProc && newProc.pid);
      if (p.ok) {
        this._setState("primary", "RUNNING", `快速路径第 ${i} 次重启后探针通过`);
        this._log(`快速路径成功（第 ${i} 次）`);
        await this.autoResume(); // 重启成功后自动恢复最后活跃会话（不阻塞返回）
        return { ok: true, attempts: i };
      }
      this._log(`第 ${i} 次重启后探针未通过: alive=${p.alive} pidMatch=${p.pidMatch} http=${p.httpOk} health=${p.health} stale=${p.stale}`);
    }
    this._setState("primary", "DOWN", `快速路径 ${this.cfg.fastPath.restartAttempts} 次均失败`);
    return { ok: false };
  }

  /**
   * 重启后自动恢复（2026-08-31 新增）：主星被重启后，会话 agent 全部终止，
   * 用户必须手动"重新发起对话"才能继续。本方法在重启探针通过后，
   * 读取主星插件记录的 last-session.json（最后活跃会话），向该会话发送
   * 一条恢复消息，让对话自动接续。可配置禁用（cfg.autoResume.enabled === false）。
   */
  async autoResume() {
    try {
      const cfg0 = this.cfg.autoResume;
      if (cfg0 && cfg0.enabled === false) {
        this._log("自动恢复已禁用（cfg.autoResume.enabled=false）");
        return;
      }
      const lastFile = path.join(this.paths.root, "last-session.json");
      if (!fs.existsSync(lastFile)) {
        this._log("自动恢复：无 last-session.json（主星插件未记录活跃会话），跳过");
        return;
      }
      let last;
      try { last = JSON.parse(fs.readFileSync(lastFile, "utf8")); } catch (e) { this._log(`自动恢复：last-session.json 解析失败: ${e.message}`); return; }
      if (!last || !last.sessionId) { this._log("自动恢复：last-session.json 无 sessionId，跳过"); return; }
      // 等主星 web 完全就绪（探针刚过，HTTP 可能还有竞态）
      await sleep(5000);
      const port = this.cfg.primaryPort || 3080;
      const message = (cfg0 && cfg0.message) || "[系统] 主星已重启，会话已自动恢复，请继续。";
      const body = JSON.stringify({
        type: "client-request",
        rpcId: "supervisor-auto-resume",
        method: "session.prompt",
        payload: { sessionId: last.sessionId, mode: "queue", content: [{ type: "text", text: message }] },
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/session.prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const text = await res.text();
      this._log(`自动恢复会话 ${last.sessionId}: HTTP ${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      this._log(`自动恢复异常: ${e.message}`);
    }
  }

  /** 慢速路径：就地跑阶梯（修复执行器在监督者侧）；阶梯用尽 → 进入顶班等待 */
  async slowPath(classification) {
    this._log(`慢速路径开始（${classification}）`);
    // 1) 发接管信号（P3：代班编排由本监督者统一执行，信号留档）
    const signal = path.join(this.paths.control, "takeover-signal.json");
    require("node:fs").writeFileSync(signal, JSON.stringify({
      ts: new Date().toISOString(),
      classification,
      reason: "快速路径失败",
    }));
    // 2) 就地跑阶梯
    let verifyPid = null;
    const result = await ladder.runLadder({
      cfg: this.cfg,
      paths_: this.paths,
      trigger: classification,
      log: (role, line) => require("./paths").log(this.paths, role, line),
      restart: async () => {
        await this.clearForeignPortOwner(); // 野生实例防护（阶梯每步重启前）
        this.restartPrimary();
        verifyPid = this.primaryProc && this.primaryProc.pid;
        await sleep(this.cfg.fastPath.verifyWaitMs || 30000);
        return { ok: true };
      },
      verify: async () => probe.probePrimary(this.cfg, this.paths, this.paths.stateFile, verifyPid),
      needsConfirm: (stepNo) => {
        // P1：自动深度以内的步骤直接执行；以上的在无控制文件许可时跳过
        return this.opts.autoConfirm ? true : false;
      },
    });
    if (result.ok) {
      this._setState("primary", "HANDED-BACK", `慢速路径: ${result.detail}`);
      await this.autoResume();
    } else {
      // 阶梯用尽 → 顶班等待（人工授权文件或超时自动）
      this.pendingTakeover = { since: Date.now(), classification };
      const autoAfterMs = (this.cfg.takeover && this.cfg.takeover.autoAfterMs) ?? 30 * 60 * 1000;
      this._setState("primary", "DOWN", `阶梯用尽，等待顶班授权（control/authorize-takeover.json 或 ${Math.round(autoAfterMs / 60000)} 分钟超时）`);
    }
    return result;
  }
