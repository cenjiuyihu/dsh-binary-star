"use strict";
/**
 * P1b 沙箱演练（验收）：
 *  演练 A — 监督者拉起沙箱主星 → 心跳出现 → 杀进程树 → 快速路径自动重启 → 探针判好
 *  演练 B — 改坏 cordis.patch.yml + 留下一笔 open 账目 → 杀进程（模拟崩溃）
 *           → 慢速路径（修复阶梯）→ 第 2 步回滚账目 → 重启 → 探针通过 → 状态恢复
 *
 * 安全边界：只操作沙箱 profile（profiles/sbx/*）与独立状态目录（binary-star-sbx）；
 * 快照 scope 为空，任何一步都不可能触碰真实 web profile。
 *
 * 用法: node scripts/drill-supervisor.js
 */
const fs = require("node:fs");
const path = require("node:path");

const SANDBOX_CONFIG = "D:/DSH/.binary-star/config.sandbox.json";
const PATCH_FILE = "C:/Users/cxm20/.dsh/profiles/sbx/cordis.patch.yml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.env.DSH_BINARY_CONFIG = SANDBOX_CONFIG;

  const pathsMod = require("../src/paths");
  const hb = require("../src/heartbeat");
  const state = require("../src/state");
  const probe = require("../src/probe");
  const journal = require("../src/journal");
  const { Supervisor, killTree } = require("../src/supervisor");

  const cfg = pathsMod.loadConfig();
  const p = pathsMod.ensureStateDirs(cfg);
  const sup = new Supervisor(cfg, p, { autoConfirm: true });

  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
  };

  // ── 预检 ──────────────────────────────────────────────
  check("沙箱 profile 存在", fs.existsSync(PATCH_FILE));
  check("插件 junction 存在", fs.existsSync("C:/Users/cxm20/.dsh/profiles/sbx/node_modules/dsh-binary-star-host/package.json"));

  // 干净起跑：杀掉可能残留的沙箱进程
  const pre = hb.readHeartbeat(p.heartbeat, "primary");
  if (pre && pre.pid && hb.isPidAlive(pre.pid)) {
    console.log(`[drill] 清理残留主星 pid=${pre.pid}`);
    killTree(pre.pid);
    await sleep(3000);
  }

  // ── 演练 A：快速路径 ───────────────────────────────────
  console.log("\n=== 演练 A：启动 → 心跳 → 杀进程 → 快速路径重启 ===");
  sup.spawnPrimary();
  await sleep(15000);
  let h1 = hb.readHeartbeat(p.heartbeat, "primary");
  check("心跳出现且 health=ok", h1 && h1.health === "ok", JSON.stringify(h1));
  const pid1 = h1 && h1.pid;
  check("心跳 PID 与进程一致", pid1 && hb.isPidAlive(pid1), `pid=${pid1}`);

  killTree(pid1);
  await sleep(3000);
  // 心跳判死窗口是 30s（3 × 10s），这里只验证进程已死（监督者按 PID 探测判死）
  check("杀后进程已死", !hb.isPidAlive(pid1), `pid=${pid1}`);

  const fast = await sup.fastPath("D1");
  check("快速路径成功", fast.ok, JSON.stringify(fast));
  const h2 = hb.readHeartbeat(p.heartbeat, "primary");
  check("新心跳健康且 PID 变化", h2 && h2.health === "ok" && h2.pid !== pid1, JSON.stringify(h2));
  const st1 = state.readState(p.stateFile);
  check("状态回到 RUNNING", st1.primary.state === "RUNNING", st1.primary.state);

  // ── 演练 B：账本崩溃回滚 ───────────────────────────────
  console.log("\n=== 演练 B：改坏配置 + open 账目 + 崩溃 → 阶梯自动回滚 ===");
  const original = fs.readFileSync(PATCH_FILE, "utf8");
  const backupDir = path.join(p.snapshots, "drill-backup");
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(backupDir, "profiles/sbx"), { recursive: true });
  fs.writeFileSync(path.join(backupDir, "profiles/sbx/cordis.patch.yml"), original);

  const entry = journal.openEntry(p.journal, {
    actor: "drill",
    desc: "演练：尝试安装坏插件（模拟改到一半崩溃）",
    scope: ["profiles/sbx/cordis.patch.yml"],
    backup: "drill-backup",
    recipe: { type: "restore-files", detail: "还原 cordis.patch.yml" },
    verify: "沙箱冒烟启动",
  });
  check("open 账目已写入", entry && entry.status === "open", JSON.stringify(entry));

  fs.appendFileSync(PATCH_FILE, "\n- insert:\n    - name: dsh-binary-star-nonexistent\n");
  check("坏行已写入（模拟破坏）", fs.readFileSync(PATCH_FILE, "utf8").includes("dsh-binary-star-nonexistent"));

  killTree(h2.pid); // 模拟改到一半崩溃
  await sleep(3000);

  const slow = await sup.slowPath("D1");
  check("慢速路径（阶梯）成功", slow.ok, JSON.stringify(slow));
  const restored = fs.readFileSync(PATCH_FILE, "utf8");
  check("patch 已还原（无坏行）", restored === original);
  const entries = journal.readEntries(p.journal);
  const e2 = entries.find((x) => x.id === entry.id);
  check("账目已标记 reverted", e2 && e2.status === "reverted", e2 && e2.status);
  const h3 = hb.readHeartbeat(p.heartbeat, "primary");
  check("主星心跳恢复", h3 && h3.health === "ok", JSON.stringify(h3));
  const st2 = state.readState(p.stateFile);
  check("状态恢复（RUNNING/HANDED-BACK）", st2.primary.state === "RUNNING" || st2.primary.state === "HANDED-BACK", st2.primary.state);

  // ── 清理 ──────────────────────────────────────────────
  console.log("\n=== 清理 ===");
  const hLast = hb.readHeartbeat(p.heartbeat, "primary");
  if (hLast && hLast.pid) killTree(hLast.pid);
  if (sup.primaryProc) killTree(sup.primaryProc.pid);
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    const hx = hb.readHeartbeat(p.heartbeat, "primary");
    if (!hx || !hx.pid || !hb.isPidAlive(hx.pid)) break;
    console.log(`[drill] 残留主星仍在，再次清理 pid=${hx.pid}`);
    killTree(hx.pid);
  }
  const hEnd = hb.readHeartbeat(p.heartbeat, "primary");
  check("清理后无存活残留", !hEnd || !hEnd.pid || !hb.isPidAlive(hEnd.pid), JSON.stringify(hEnd));

  console.log(`\n==== 演练结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[drill] 异常:", e);
  process.exit(2);
});
