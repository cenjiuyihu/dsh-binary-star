"use strict";
/**
 * 双星系统 CLI（dsh-binary）。
 * 命令: start | status | stop | repair [--now] | snapshot <tag> | halt | takeover | version
 * 纯 Node 实现（执行策略禁 ps1；Windows 直接跑 node）。
 */
const path = require("node:path");
const fs = require("node:fs");
const paths = require("./paths");
const hb = require("./heartbeat");
const state = require("./state");
const snapshot = require("./snapshot");
const journal = require("./journal");
const ladder = require("./ladder");
const probe = require("./probe");
const { Supervisor, killTree } = require("./supervisor");

/** 读监督者单实例锁 */
function readLock(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(p.locks, "supervisor.lock"), "utf8"));
  } catch {
    return null;
  }
}

function printStatus(cfg, p) {
  const st = state.readState(p.stateFile);
  const ph = hb.readHeartbeat(p.heartbeat, "primary");
  const sh = hb.readHeartbeat(p.heartbeat, "satellite");
  const lines = [
    "── 双星系统状态 ──",
    `dsh 版本: ${snapshot.dshVersion(cfg.dshPkg)}`,
    `监督者: ${st.supervisor.state} (since ${st.supervisor.since || "-"})`,
    `主星  : ${st.primary.state} | ${hb.summarize(ph)}`,
    `卫星  : ${st.satellite.state} | ${hb.summarize(sh)}`,
  ];
  const entries = journal.readEntries(p.journal);
  const open = journal.findOpen(entries);
  lines.push(`账本  : ${entries.length} 条, open ${open.length} 条${open.length ? " ⚠ " + open.map((e) => e.id).join(",") : ""}`);
  const snaps = snapshot.listSnapshots(p);
  lines.push(`快照  : ${snaps.length} 个${snaps.length ? ` (最新: ${snaps[0].name})` : ""}`);
  if (st.lastRepair) lines.push(`上次修复: ${JSON.stringify(st.lastRepair)}`);
  console.log(lines.join("\n"));
}

async function main() {
  const cfg = paths.loadConfig();
  const p = paths.ensureStateDirs(cfg);
  const cmd = process.argv[2];
  const arg = process.argv[3];

  switch (cmd) {
    case "start": {
      const sup = new Supervisor(cfg, p, { autoConfirm: true });
      if (!sup.acquireLock()) {
        console.error("已有监督者在运行（单实例锁被占用），退出。若确认已无监督者，删除 locks/supervisor.lock 后重试。");
        process.exit(1);
      }
      console.log("监督者启动中……（前台常驻进程：本窗口将被持续占用，这是正常现象，不是卡死）");
      console.log("  停止方式：另开一个窗口执行 `dsh-binary stop`，或在本窗口按 Ctrl+C。");
      console.log("  日常建议：由桌面壳控制台（启动/停止按钮）管理监督者，无需手动开窗口。");
      process.on("exit", () => sup.releaseLock());
      await sup.start();
      break;
    }
    case "status": {
      printStatus(cfg, p);
      break;
    }
    case "stop": {
      const shutdownFile = path.join(p.control, "shutdown");
      const lock = readLock(p);
      if (lock && lock.pid && hb.isPidAlive(lock.pid)) {
        fs.writeFileSync(shutdownFile, JSON.stringify({ ts: new Date().toISOString(), by: "cli" }));
        console.log("已请求监督者受控关闭（control/shutdown）；监督者将停止主星并退出");
      } else {
        const ph = hb.readHeartbeat(p.heartbeat, "primary");
        if (ph && ph.pid && hb.isPidAlive(ph.pid)) killTree(ph.pid);
        const sh = hb.readHeartbeat(p.heartbeat, "satellite");
        if (sh && sh.pid && hb.isPidAlive(sh.pid)) killTree(sh.pid);
        console.log("监督者未在运行，已直接停止主星/卫星进程树");
      }
      break;
    }
    case "snapshot": {
      const tag = arg || "manual";
      const r = snapshot.snapshotScope(cfg, p, tag);
      console.log(`快照完成: ${r.dir}`);
      console.log(`  dsh 版本: ${r.meta.dshVersion} | 覆盖 ${r.meta.copied.length} 项`);
      break;
    }
    case "repair": {
      if (arg !== "--now") {
        console.log("用法: dsh-binary repair --now");
        break;
      }
      const result = await ladder.runLadder({
        cfg,
        paths_: p,
        log: (role, line) => paths.log(p, role, line),
        restart: async () => { console.log("（手动 repair 不自动重启，请先 dsh-binary start）"); return { ok: true }; },
        verify: async () => probe.probePrimary(cfg, p, p.stateFile),
        needsConfirm: () => true,
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "takeover": {
      if (arg === "--now") {
        const authFile = path.join(p.control, "authorize-takeover.json");
        fs.writeFileSync(authFile, JSON.stringify({ ts: new Date().toISOString(), by: "cli" }));
        console.log("已写入顶班授权（control/authorize-takeover.json），监督者将在下一 tick 执行代班接管");
        break;
      }
      if (arg === "--undo") {
        const hbFile = path.join(p.control, "handback-request.json");
        fs.writeFileSync(hbFile, JSON.stringify({ ts: new Date().toISOString(), by: "cli" }));
        console.log("已写入交回请求（control/handback-request.json），监督者将在下一 tick 执行");
        break;
      }
      console.log("用法: dsh-binary takeover --now | --undo");
      break;
    }
    case "halt": {
      fs.writeFileSync(path.join(p.control, "halt"), new Date().toISOString());
      console.log("已暂停自动修复（control/halt）。恢复: 删除该文件或 dsh-binary resume（P2 提供）");
      break;
    }
    case "journal": {
      const sub = arg;
      const rest = process.argv.slice(4);
      if (sub === "open") {
        const desc = rest.includes("--desc") ? rest[rest.indexOf("--desc") + 1] : "未描述";
        let scope = [];
        if (rest.includes("--scope")) {
          scope = String(rest[rest.indexOf("--scope") + 1] || "").split(",").map((s) => s.trim()).filter(Boolean);
        }
        const restartRequired = rest.includes("--restart-required");
        const entry = journal.openEntry(p.journal, { actor: "agent", desc, scope, recipe: { type: "restore-files" }, restartRequired });
        const backupDir = path.join(p.snapshots, `pre-${entry.id}`);
        fs.mkdirSync(backupDir, { recursive: true });
        for (const rel of scope) {
          const src = path.join(cfg.dshHome, rel);
          if (fs.existsSync(src)) fs.cpSync(src, path.join(backupDir, rel), { recursive: true });
        }
        journal.setBackup(p.journal, entry.id, `pre-${entry.id}`);
        console.log(`账目 ${entry.id} 已开启：${desc}`);
        console.log(`  scope: ${scope.join(", ") || "(无)"} | 备份: ${backupDir}`);
        console.log(`  修改完成后: dsh-binary journal commit ${entry.id}`);
        if (restartRequired) {
          console.log(`  需重启生效：修改后写 ${path.join(p.control, "restart-request.json")}（{journalEntryId, desc}）触发受控自重启验证`);
        }
        break;
      }
      if (sub === "commit") {
        journal.commitEntry(p.journal, rest[0]);
        console.log(`账目 ${rest[0]} 已提交`);
        break;
      }
      if (sub === "rollback") {
        const entries = journal.readEntries(p.journal);
        const e = entries.find((x) => x.id === rest[0]);
        if (!e) { console.error("账目不存在:", rest[0]); break; }
        const r = ladder.restoreEntryFiles(cfg, p, e);
        journal.markReverted(p.journal, e.id, "手动回滚");
        console.log(`账目 ${e.id} 已回滚，还原 ${r.restored.length} 个文件: ${r.restored.join(", ")}`);
        break;
      }
      if (sub === "list") {
        const entries = journal.readEntries(p.journal);
        const open = journal.findOpen(entries);
        for (const e of entries.slice(-15).reverse()) {
          console.log(`${e.id} [${e.status}] ${e.ts} ${e.desc}${e.restartRequired ? " (需重启)" : ""}`);
        }
        console.log(`共 ${entries.length} 条，open ${open.length} 条`);
        break;
      }
      console.log("用法: dsh-binary journal <open|commit|rollback|list> ...");
      break;
    }
    case "version": {
      console.log(`dsh-binary 0.1.0 (dsh ${snapshot.dshVersion(cfg.dshPkg)})`);
      break;
    }
    default: {
      console.log(`用法: dsh-binary <start|status|stop|snapshot <tag>|repair --now|halt|version>
  start     启动监督者（拉起主星并监视；卫星在 P2 接入）
  status    双星状态一览
  stop      停掉监督者拉起的双星进程树
  snapshot  打快照（tag: baseline|pre|daily|manual）
  repair --now 手动触发修复阶梯
  halt      暂停自动修复`);
    }
  }
}

main().catch((e) => {
  console.error("CLI 错误:", e);
  process.exit(1);
});
