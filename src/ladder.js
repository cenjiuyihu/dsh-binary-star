"use strict";
/**
 * 双星系统：修复阶梯（企划 §6 / §14）。
 * 每步"动作 → 验证"，验证通过即停，连续失败升一级。
 *
 * 步骤：
 *   0 强杀 → 原样重启 → 验证            （D3 挂死 / 偶发崩溃）
 *   1 校验配置 → 就地修 → 重启 → 验证    （D1 语法级故障）
 *   2 回滚账本 open 条目 → 重启 → 验证   （改到一半崩溃）
 *   3 回滚最近 N 条 committed → 重启 → 验证
 *   4 快照还原（破坏性，需确认）
 *   5 重装 last-known-good dsh 版本 + 重跑 ui-patch（破坏性，需确认）
 *   6 顶班（卫星接管，需确认/超时自动）
 *
 * P1 实现 0/2/3 的核心逻辑；1 的配置校验与 4/5/6 的完整执行在 P2 与卫星协同完成。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const journal = require("./journal");
const snapshot = require("./snapshot");
const probe = require("./probe");

function cfgYamlExists(cfg, rel) {
  return fs.existsSync(path.join(cfg.dshHome, rel));
}

/**
 * 第 1 步：配置校验。
 *  1) 轻量结构检查（文件存在 + patch 的 insert 块带 id）；
 *  2) 真实冒烟：`node bin.js --profile <name> --dump-config` —— 组合树完整解析失败会非 0 退出。
 *     （dump-config 不启动服务，安全；对语法/结构/包解析类故障是决定性判据。）
 */
function validateConfig(cfg) {
  const issues = [];
  const checks = [
    ["profiles/web/cordis.patch.yml", "组合补丁层"],
    ["profiles/web/package.json", "profile 依赖与 bundles"],
    ["settings.yaml", "全局设置"],
  ];
  for (const [rel, name] of checks) {
    if (!cfgYamlExists(cfg, rel)) issues.push(`缺失 ${name}: ${rel}`);
  }
  const patch = path.join(cfg.dshHome, "profiles/web/cordis.patch.yml");
  if (cfgYamlExists(cfg, "profiles/web/cordis.patch.yml")) {
    const text = fs.readFileSync(patch, "utf8");
    const insertLines = text.split("\n").filter((l) => l.trim().startsWith("- id:"));
    if (text.includes("insert:") && insertLines.length === 0) {
      issues.push("cordis.patch.yml 存在 insert 块但无任何 - id: 行");
    }
  }
  if (issues.length === 0) {
    const bin = path.join(cfg.dshPkg, "lib", "bin.js");
    const r = spawnSync(process.execPath, [bin, "--profile", cfg.primaryProfile, "--dump-config"], {
      cwd: cfg.primaryWorkdir,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      const err = String(r.stderr || "").trim().slice(0, 400);
      issues.push(`组合树冒烟失败 (dump-config 退出码 ${r.status}): ${err}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 从账目 backup 目录恢复文件到 DSH_HOME（第 2/3 步的还原动作） */
function restoreEntryFiles(cfg, paths_, entry) {
  if (!entry.backup) return { restored: [] };
  const backupDir = path.join(paths_.snapshots, entry.backup);
  if (!fs.existsSync(backupDir)) return { restored: [], missing: true };
  const restored = [];
  for (const rel of entry.scope || []) {
    const from = path.join(backupDir, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(cfg.dshHome, rel);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    restored.push(rel);
  }
  return { restored };
}

/**
 * 执行阶梯（P1 版：0/1/2/3 核心 + 4/5/6 确认门与占位）。
 * ctx: { cfg, paths_, stateFile, restart, verify, log, needsConfirm }
 * restart: 由监督者注入的"重启主星并等待探针"函数
 */
async function runLadder(ctx) {
  const { cfg, log } = ctx;
  const autoMax = cfg.ladder.autoRepairMaxStep; // 默认 3
  // 修复报告：每次阶梯执行写 logs/repair/<ts>.json（结构化历史）
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    ts: new Date().toISOString(),
    trigger: ctx.trigger || "unknown",
    autoMax,
    steps: [],
    outcome: null,
    detail: null,
  };
  const writeReport = () => {
    try {
      const dir = path.join(ctx.paths_.logs, "repair");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
    } catch {}
  };
  log("ladder", "=== 修复阶梯开始 ===");

  const steps = [
    // 第 0 步的"重启"由统一验证阶段执行（每个动作成功后都会 restart + verify）
    { no: 0, name: "强杀重启", run: () => ({ ok: true, detail: "重启在验证阶段执行" }) },
    {
      no: 1, name: "校验配置",
      run: () => {
        const v = validateConfig(cfg);
        if (!v.ok) return { ok: false, detail: `配置问题: ${v.issues.join("; ")}` };
        return { ok: true, detail: "配置校验通过" };
      },
    },
    {
      no: 2, name: "回滚 open 账目",
      run: () => {
        const entries = journal.readEntries(ctx.paths_.journal);
        const open = journal.findOpen(entries);
        if (open.length === 0) return { ok: false, detail: "无 open 账目" };
        let restored = [];
        for (const e of open) {
          const r = restoreEntryFiles(cfg, ctx.paths_, e);
          restored = restored.concat(r.restored);
          journal.markReverted(ctx.paths_.journal, e.id, "阶梯第 2 步自动回滚");
          log("ladder", `回滚 open 账目 ${e.id}: ${e.desc}`);
        }
        return { ok: restored.length > 0, detail: `已回滚 ${restored.length} 个文件` };
      },
    },
    {
      no: 3, name: "回滚最近 committed 账目",
      run: () => {
        const entries = journal.readEntries(ctx.paths_.journal);
        const cands = journal.recentCommitted(entries, cfg.journal.maxRollbackEntries);
        if (cands.length === 0) return { ok: false, detail: "无 committed 账目可回滚" };
        let restored = [];
        for (const e of cands) {
          const r = restoreEntryFiles(cfg, ctx.paths_, e);
          restored = restored.concat(r.restored);
          journal.markReverted(ctx.paths_.journal, e.id, "阶梯第 3 步自动回滚");
          log("ladder", `回滚 committed 账目 ${e.id}: ${e.desc}`);
        }
        return { ok: restored.length > 0, detail: `已回滚 ${restored.length} 个文件（${cands.length} 条账目）` };
      },
    },
    {
      no: 4, name: "快照还原",
      run: () => {
        const snaps = snapshot.listSnapshots(ctx.paths_);
        if (snaps.length === 0) return { ok: false, detail: "无快照可还原" };
        const r = snapshot.restoreSnapshot(cfg, ctx.paths_, snaps[0].name);
        return { ok: true, detail: `已从 ${snaps[0].name} 还原 ${r.restored.length} 项` };
      },
    },
    {
      no: 5, name: "重装 dsh 版本",
      run: () => {
        // 需要 last-known-good 版本号（账本/快照 meta 记录）；P2 完善
        return { ok: false, detail: "P2 实现：npm.cmd install -g @deepseek-ai/dsh@<lkg> + 重跑 ui-patch" };
      },
    },
    { no: 6, name: "顶班", run: () => ({ ok: false, detail: "P2 实现：卫星接管 :3080" }) },
  ];

  for (const step of steps) {
    if (step.no > autoMax && !ctx.needsConfirm(step.no)) {
      log("ladder", `第 ${step.no} 步超出自动修复深度(≤${autoMax})，跳过（等待人工确认）`);
      continue;
    }
    log("ladder", `-- 第 ${step.no} 步：${step.name}`);
    let r;
    try {
      r = await step.run();
    } catch (e) {
      r = { ok: false, detail: e.message };
    }
    log("ladder", `   结果: ${r.ok ? "OK" : "FAIL"} - ${r.detail}`);
    const stepRecord = { no: step.no, name: step.name, actionOk: !!r.ok, detail: r.detail || null };
    if (step.no >= 0 && r.ok) {
      // 动作成功后：重启 + 探针验证（每步"动作 → 重启 → 验证"）
      await ctx.restart();
      await sleep(ctx.verifyWaitMs ?? 30000);
      const v = await ctx.verify();
      stepRecord.verifyOk = !!v.ok;
      stepRecord.verifyDetail = v.ok ? null : `alive=${v.alive} pidMatch=${v.pidMatch} health=${v.health}`;
      report.steps.push(stepRecord);
      if (v.ok) {
        report.outcome = "recovered";
        report.detail = `第 ${step.no} 步（${step.name}）成功后探针通过`;
        writeReport();
        log("ladder", `=== 阶梯成功（第 ${step.no} 步，探针通过）===`);
        return { ok: true, step: step.no, detail: r.detail, report: `${stamp}.json` };
      }
      log("ladder", `   第 ${step.no} 步动作成功但探针未通过，继续升级`);
    } else {
      stepRecord.verifyOk = null;
      report.steps.push(stepRecord);
    }
  }
  report.outcome = "exhausted";
  report.detail = "阶梯全部失败";
  writeReport();
  log("ladder", "=== 阶梯全部失败，需要人工介入（或顶班）===");
  return { ok: false, step: null, detail: "阶梯用尽", report: `${stamp}.json` };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runLadder, validateConfig, restoreEntryFiles };
