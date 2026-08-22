"use strict";
/**
 * 双星系统：监督者（三层架构的最外层，永不依赖 LLM）。
 * 职责：
 *  1. 拉起主星（与桌面壳同款命令）
 *  2. 心跳监视 + 故障分类（D1 启动失败 / D2 功能性故障 / D3 挂死）
 *  3. 快速路径：重启 + 探针验证（成功判据 = 探针通过，不只是进程活）
 *  4. 慢速路径：修复阶梯；阶梯用尽 → 顶班等待 → 代班接管 → 交回归档
 *  5. 受控关闭（control/shutdown）与孤儿检测（DSH_BINARY_PARENT_PID）
 */
const { spawn, spawnSync } = require("node:child_process");
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
    this.opts = opts;
    this.primaryProc = null;
    this.running = false;
    this.restartCount = { hourStart: Date.now(), count: 0 };
    // 归属 token：每次监督者启动生成，注入子进程 env；心跳必须携带它才算可信
    this.token = randomUUID();
    this.cfg.token = this.token;
    // 启动宽限只适用于"本监督者启动后从未健康起来过"的实例
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
      stdio: ["ignore", "pipe", "pipe"],
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

  /** 快速路径：重启 + 探针验证（成功判据=探针通过，且绑定新进程 pid） */
  async fastPath(classification) {
    this._log(`快速路径开始（${classification}），尝试 ${this.cfg.fastPath.restartAttempts} 次`);
    for (let i = 1; i <= this.cfg.fastPath.restartAttempts; i++) {
      this.restartPrimary();
      const newProc = this.primaryProc;
      await sleep(this.cfg.fastPath.verifyWaitMs || 30000);
      const p = await probe.probePrimary(this.cfg, this.paths, this.paths.stateFile, newProc && newProc.pid);
      if (p.ok) {
        this._setState("primary", "RUNNING", `快速路径第 ${i} 次重启后探针通过`);
        this._log(`快速路径成功（第 ${i} 次）`);
        return { ok: true, attempts: i };
      }
      this._log(`第 ${i} 次重启后探针未通过: alive=${p.alive} pidMatch=${p.pidMatch} http=${p.httpOk} health=${p.health} stale=${p.stale}`);
    }
    this._setState("primary", "DOWN", `快速路径 ${this.cfg.fastPath.restartAttempts} 次均失败`);
    return { ok: false };
  }

  /** 慢速路径：就地跑阶梯；阶梯用尽 → 进入顶班等待 */
  async slowPath(classification) {
    this._log(`慢速路径开始（${classification}）`);
    const signal = path.join(this.paths.control, "takeover-signal.json");
    require("node:fs").writeFileSync(signal, JSON.stringify({
      ts: new Date().toISOString(),
      classification,
      reason: "快速路径失败",
    }));
    let verifyPid = null;
    const result = await ladder.runLadder({
      cfg: this.cfg,
      paths_: this.paths,
      trigger: classification,
      log: (role, line) => require("./paths").log(this.paths, role, line),
      restart: async () => {
        this.restartPrimary();
        verifyPid = this.primaryProc && this.primaryProc.pid;
        await sleep(this.cfg.fastPath.verifyWaitMs || 30000);
        return { ok: true };
      },
      verify: async () => probe.probePrimary(this.cfg, this.paths, this.paths.stateFile, verifyPid),
      needsConfirm: (stepNo) => this.opts.autoConfirm ? true : false,
    });
    if (result.ok) {
      this._setState("primary", "HANDED-BACK", `慢速路径: ${result.detail}`);
    } else {
      this.pendingTakeover = { since: Date.now(), classification };
      const autoAfterMs = (this.cfg.takeover && this.cfg.takeover.autoAfterMs) ?? 30 * 60 * 1000;
      this._setState("primary", "DOWN", `阶梯用尽，等待顶班授权（control/authorize-takeover.json 或 ${Math.round(autoAfterMs / 60000)} 分钟超时）`);
    }
    return result;
  }

  /** 代班实例：卫星 profile（副本，永远健康）+ 代班端口 + 卫星工作区（会话隔离） */
  spawnTakeover() {
    const t = this.cfg.takeover || {};
    const port = t.port ?? 3080;
    const profile = t.profile || this.cfg.satelliteProfile;
    const args = [path.join(this.cfg.dshPkg, "lib", "bin.js"), "--profile", profile, "--port", String(port)];
    this._log(`拉起代班实例: ${process.execPath} ${args.join(" ")} (cwd=${this.cfg.satelliteWorkdir})`);
    const proc = spawn(process.execPath, args, {
      cwd: this.cfg.satelliteWorkdir,
      env: { ...process.env, DSH_BINARY_ROLE: "takeover", DSH_BINARY_STATE: this.cfg.stateDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.takeoverProc = proc;
    proc.stdout.on("data", (d) => this._log(`[takeover:out] ${String(d).trim().slice(0, 200)}`));
    proc.stderr.on("data", (d) => this._log(`[takeover:err] ${String(d).trim().slice(0, 200)}`));
    proc.on("exit", (code, sig) => {
      this._log(`代班实例退出 code=${code} sig=${sig}`);
      if (this.takeoverProc !== proc) return;
      this.takeoverProc = null;
      // 卫星自愈：若非主动交回（handingBack）且仍处 TAKEOVER、重启未超限 → 延迟重启代班
      if (!this.handingBack) {
        const st = this._readState();
        if (st.satellite.state === "TAKEOVER" && (this.takeoverRestarts || 0) < 3) {
          this.takeoverRestarts = (this.takeoverRestarts || 0) + 1;
          this._log(`代班实例意外退出（第 ${this.takeoverRestarts} 次），10 秒后自愈重启`);
          const t = this.cfg.takeover || {};
          const port = t.port ?? 3080;
          setTimeout(() => {
            if (this._readState().satellite.state === "TAKEOVER" && !this.takeoverProc) {
              this._log("自愈：重启代班实例");
              const proc2 = this.spawnTakeover();
              probe.waitForHttp(`http://127.0.0.1:${port}/`, 60000).then((ready) => {
                if (ready.ok) {
                  const st2 = this._readState();
                  st2.takeover = { pid: proc2.pid, port, since: new Date().toISOString(), classification: "self-heal" };
                  state.writeState(this.paths.stateFile, st2);
                  this._log(`代班实例自愈就绪 :${port}（pid=${proc2.pid}）`);
                } else {
                  this._log("代班实例自愈失败");
                }
              });
            }
          }, 10000);
        } else {
          this._setState("satellite", "STANDBY", "代班实例已停止（自愈超限）");
        }
      }
    });
    return proc;
  }

  /** 顶班流程：杀主星（若活）→ 会话种子 → 拉起代班 → HTTP 验证 */
  async takeoverFlow(classification) {
    this._log(`=== 顶班开始（${classification}）===`);
    if (this.primaryProc) {
      this._log("顶班前强杀主星进程树（主星数据原地保留）");
      killTree(this.primaryProc.pid);
      await sleep(2000);
    }
    const t = this.cfg.takeover || {};
    const seedResult = seed.writeSeed(
      t.sessionsRoot || path.join(this.cfg.dshHome, "sessions"),
      this.cfg.stateDir,
      t.seedLastN ?? 40
    );
    this._log(`会话种子: ${seedResult.ok ? `ok（${seedResult.meta.messageCount} 条，${seedResult.meta.sessionId}）` : `跳过（${seedResult.reason}）`}`);
    const proc = this.spawnTakeover();
    const port = t.port ?? 3080;
    const ready = await probe.waitForHttp(`http://127.0.0.1:${port}/`, 90000);
    if (ready.ok) {
      this._setState("satellite", "TAKEOVER", `代班 :${port}`);
      this.takeoverRestarts = 0;
      const st = this._readState();
      st.takeover = { pid: proc.pid, port, since: new Date().toISOString(), classification, seedOk: seedResult.ok };
      state.writeState(this.paths.stateFile, st);
      this._log(`代班实例就绪 :${port}（pid=${proc.pid}）`);
    } else {
      this._setState("satellite", "STANDBY", "代班实例未就绪");
      this._log(`代班实例未就绪（HTTP ${ready.statusCode}）`);
    }
    return { ok: ready.ok, port };
  }

  /** 交回：杀代班 → 归档代班会话 → 重启主星 */
  async handback() {
    this._log("=== 交回开始 ===");
    this.handingBack = true;
    try {
      if (this.takeoverProc) {
        this._log("停止代班实例");
        killTree(this.takeoverProc.pid);
        await sleep(2000);
        this.takeoverProc = null;
      }
    } finally {
      this.handingBack = false;
    }
    try {
      const srcRoot = path.join(this.cfg.dshHome, "sessions", encodeWorkspace(this.cfg.satelliteWorkdir));
      const dstRoot = path.join(this.cfg.dshHome, "sessions", encodeWorkspace(this.cfg.primaryWorkdir));
      let archived = 0;
      if (fs.existsSync(srcRoot)) {
        fs.mkdirSync(dstRoot, { recursive: true });
        for (const n of fs.readdirSync(srcRoot)) {
          const src = path.join(srcRoot, n);
          const dst = path.join(dstRoot, n);
          if (fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true });
            archived++;
          }
        }
      }
      this._log(`代班会话归档: ${archived} 个会话已并入主星会话列表`);
    } catch (e) {
      this._log(`代班会话归档失败（降级：保留在卫星工作区）: ${e.message}`);
    }
    this._setState("satellite", "STANDBY", "已交回");
    const st = this._readState();
    st.takeover = null;
    state.writeState(this.paths.stateFile, st);
    this.spawnPrimary();
    this._setState("primary", "VERIFYING", "交回后重启中");
    this._log("主星已重启，等待探针确认（由 tick 完成）");
  }

  /** 故障分类（D1/D2/D3/D4） */
  classify(heartbeat, probeResult) {
    const now = Date.now();
    if (probeResult.health && probeResult.health !== "ok" && probeResult.health !== "unknown") {
      return "D2";
    }
    if (probeResult.alive) return "D3";
    if (
      !this.sawHealthyHeartbeat &&
      now - this.bootedAt < this.cfg.heartbeat.bootGraceMs &&
      this.bootExits < 2
    ) {
      return "BOOT_GRACE";
    }
    return "D1";
  }

  /** 受控自重启验证：restart-request.json → 受控重启 → 探针验证 → 失败阶梯回滚（3 次上限） */
  async checkRestartRequest() {
    const reqFile = path.join(this.paths.control, "restart-request.json");
    if (!fs.existsSync(reqFile)) return false;
    let req = null;
    try { req = JSON.parse(fs.readFileSync(reqFile, "utf8")); } catch {}
    if (!req || !req.journalEntryId) {
      fs.rmSync(reqFile, { force: true });
      return false;
    }
    const attempts = Number(req.attempts || 0);
    if (attempts >= 3) {
      this._log(`受控自重启请求 ${req.journalEntryId} 已尝试 3 次仍失败，标记 failed 停止自动重试`);
      fs.renameSync(reqFile, `${reqFile}.failed`);
      this._setState("primary", "DOWN", `受控自重启失败×3，待人工（${req.journalEntryId}）`);
      return true;
    }
    this._log(`受控自重启请求: 账目 ${req.journalEntryId} (${req.desc || "无描述"}) 第 ${attempts + 1} 次`);
    this._setState("primary", "VERIFYING", `受控自重启验证（${req.journalEntryId}）`);
    this.restartPrimary();
    const newProc = this.primaryProc;
    await sleep(this.cfg.fastPath.verifyWaitMs || 30000);
    const pr = await probe.probePrimary(this.cfg, this.paths, this.paths.stateFile, newProc && newProc.pid);
    if (pr.ok) {
      fs.rmSync(reqFile, { force: true });
      this._setState("primary", "RUNNING", `受控自重启验证通过（${req.journalEntryId}）`);
      this._log(`受控自重启验证通过（${req.journalEntryId}）`);
      return true;
    }
    this._log(`受控自重启验证失败（${req.journalEntryId}），进入修复阶梯`);
    const result = await this.slowPath("CONTROLLED_RESTART");
    if (result.ok) {
      fs.rmSync(reqFile, { force: true });
    } else {
      req.attempts = attempts + 1;
      fs.writeFileSync(reqFile, JSON.stringify(req));
    }
    return true;
  }

  /** 受控关闭：control/shutdown 文件存在 → 杀主星 → 释放锁 → 退出 */
  handleShutdownRequest() {
    const file = path.join(this.paths.control, "shutdown");
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    this._log("收到 control/shutdown，执行受控关闭");
    if (this.primaryProc) {
      this._log("关闭主星进程树");
      killTree(this.primaryProc.pid);
    }
    this.releaseLock();
    this.running = false;
    process.exit(0);
  }

  /** 孤儿检测：父进程（桌面壳）已死 → 自行清理退出 */
  handleOrphanCheck() {
    const parentPid = Number(process.env.DSH_BINARY_PARENT_PID || 0);
    if (!parentPid || parentPid <= 0) return false;
    if (!hb.isPidAlive(parentPid)) {
      this._log(`父进程（${parentPid}）已退出，判定为孤儿，自行清理退出`);
      if (this.primaryProc) {
        this._log("关闭主星进程树");
        killTree(this.primaryProc.pid);
      }
      this.releaseLock();
      this.running = false;
      process.exit(0);
    }
    return false;
  }

  /** 监视循环（单次 tick） */
  async tick() {
    if (this.handleShutdownRequest()) return;
    if (this.handleOrphanCheck()) return;
    const handbackFile = path.join(this.paths.control, "handback-request.json");
    if (fs.existsSync(handbackFile)) {
      fs.rmSync(handbackFile, { force: true });
      try {
        await this.handback();
        return;
      } catch (e) {
        this._log(`handback 异常: ${e.message}`);
      }
    }
    if (this.pendingTakeover) {
      const t = this.cfg.takeover || {};
      const authFile = path.join(this.paths.control, "authorize-takeover.json");
      const haltFile = path.join(this.paths.control, "halt");
      const autoAfterMs = t.autoAfterMs ?? 30 * 60 * 1000;
      const authorized = fs.existsSync(authFile) || Date.now() - this.pendingTakeover.since >= autoAfterMs;
      const cls = this.pendingTakeover.classification;
      if (authorized && !fs.existsSync(haltFile)) {
        this._log(`顶班授权确认（${fs.existsSync(authFile) ? "人工授权" : "超时自动"}），执行代班接管`);
        fs.rmSync(authFile, { force: true });
        this.pendingTakeover = null;
        try {
          await this.takeoverFlow(cls);
          return;
        } catch (e) {
          this._log(`takeoverFlow 异常: ${e.message}`);
        }
      } else if (fs.existsSync(haltFile)) {
        this._log("人工 halt：取消顶班等待");
        this.pendingTakeover = null;
        return;
      } else {
        const pr = await probe.probePrimary(this.cfg, this.paths, this.paths.stateFile);
        if (pr.ok) {
          this._log("主星已恢复，取消顶班等待");
          this.pendingTakeover = null;
          this._setState("primary", "RUNNING", "等待期间恢复");
          return;
        }
        return;
      }
    }
    try {
      if (await this.checkRestartRequest()) return;
    } catch (e) {
      this._log(`checkRestartRequest 异常: ${e.message}`);
    }
    const h = hb.readHeartbeat(this.paths.heartbeat, "primary");
    const pr = await probe.probePrimary(this.cfg, this.paths, this.paths.stateFile);
    if (h && !hb.isStale(h, this.cfg.heartbeat) && pr.ok) {
      this.sawHealthyHeartbeat = true;
      if (this._readState().primary.state !== "RUNNING") {
        this._setState("primary", "RUNNING", "心跳与探针正常");
      }
      return;
    }
    if (h && hb.isStale(h, this.cfg.heartbeat) === false && pr.health === "ok" && !pr.httpOk) {
      this._log("GUI HTTP 不可达但心跳正常（D4 候选，暂不处置）");
      return;
    }
    const cls = this.classify(h, pr);
    if (cls === "BOOT_GRACE") {
      this._log(`启动宽限期内（${this.cfg.heartbeat.bootGraceMs}ms），等待首个健康心跳`);
      return;
    }
    this._log(`检测到故障: ${cls} (hb=${hb.summarize(h)} alive=${pr.alive} http=${pr.httpOk} trusted=${pr.trusted})`);
    this._setState("primary", cls === "D2" ? "DEGRADED" : "DOWN", cls);
    const now = Date.now();
    if (now - this.restartCount.hourStart > 3600_000) {
      this.restartCount = { hourStart: now, count: 0 };
    }
    if (this.restartCount.count >= (this.cfg.fastPath.restartAttempts + 1) * 3) {
      this._log("速率限制触发：跳过本轮自动处置，等待人工");
      return;
    }
    this.restartCount.count++;
    const fast = await this.fastPath(cls);
    if (!fast.ok) {
      await this.slowPath(cls);
    }
  }

  /** 单实例锁：防止双监督者互相抢着重启 */
  acquireLock() {
    const lockFile = path.join(this.paths.locks, "supervisor.lock");
    try {
      const prev = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (prev && prev.pid && hb.isPidAlive(prev.pid)) {
        this._log(`单实例锁被占用（pid=${prev.pid}），拒绝启动`);
        return false;
      }
    } catch {}
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return true;
  }

  releaseLock() {
    try {
      const lockFile = path.join(this.paths.locks, "supervisor.lock");
      const prev = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (prev && prev.pid === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {}
  }

  /** 启动前的所有权接管：已有主星在运行（桌面壳拉起）→ 一次性交接 */
  async ensurePrimaryOwnership() {
    const h = hb.readHeartbeat(this.paths.heartbeat, "primary");
    const fresh = h && !hb.isStale(h, this.cfg.heartbeat) && hb.isPidAlive(h.pid);
    if (fresh) {
      this._log(`发现已运行的主星 pid=${h.pid}（非本监督者管理），执行一次性接管交接`);
      killTree(h.pid);
      await sleep(5000);
      return;
    }
    const port = this.cfg.primaryPort || 3080;
    if (this.cfg.probe && this.cfg.probe.httpCheck === false) return;
    const portPid = this.findPidByPort(port);
    if (portPid && portPid !== process.pid) {
      this._log(`发现 :${port} 被 pid=${portPid} 占用（无心跳），执行接管交接`);
      killTree(portPid);
      await sleep(5000);
    }
  }

  /** 通过端口找监听进程 pid（Windows） */
  findPidByPort(port) {
    const r = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
    ], { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
    const pid = Number(String(r.stdout || "").trim());
    return pid > 0 ? pid : null;
  }

  /** 启动监督者（阻塞式监视循环） */
  async start() {
    if (this.running) return;
    this.running = true;
    this._setState("supervisor", "SUPERVISING", "启动");
    await this.ensurePrimaryOwnership();
    this.spawnPrimary();
    this._log("监督者进入监视循环");
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        this._log(`tick 异常: ${e.stack || e.message}`);
      }
      await sleep(this.cfg.heartbeat.watchIntervalMs || 10000);
    }
    this.releaseLock();
  }

  stop() {
    this.running = false;
    if (this.primaryProc) {
      this._log("监督者停止，杀主星进程树");
      killTree(this.primaryProc.pid);
    }
    this.releaseLock();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Supervisor, killTree };
