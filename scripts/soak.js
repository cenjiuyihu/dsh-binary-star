"use strict";
/**
 * 长时韧性演练（soak）：随机注入故障 N 轮，记录每轮恢复时间，验证系统在
 * 反复故障下不自旋、不挂死、最终总能恢复。
 *
 * 故障池（每轮随机选一个）：
 *  - kill:      强杀主星（D1/D3）
 *  - badpatch:  改坏 sbx patch（配置级故障，阶梯回滚路径）
 *  - hbstall:   心跳 tmp 堵塞（进程活、心跳停 → D3）
 *
 * 安全边界：只操作沙箱 profile（profiles/sbx）与独立状态目录（binary-star-sbx）。
 * 用法: node scripts/soak.js [轮数=8]
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir().replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..").replace(/\\/g, "/");
const SBX_ROOT = process.env.DSH_SBX_ROOT || path.join(ROOT, "..", ".binary-star").replace(/\\/g, "/");
const SANDBOX_CONFIG = process.env.DSH_SBX_CONFIG || path.join(SBX_ROOT, "config.sandbox.json").replace(/\\/g, "/");
const STATE = process.env.DSH_SBX_STATE || path.join(HOME, ".dsh", "binary-star-sbx").replace(/\\/g, "/");
const STATE_FILE = `${STATE}/state.json`;
const HB_FILE = `${STATE}/heartbeat/primary.json`;
const SBX_PATCH = process.env.DSH_SBX_PATCH || path.join(HOME, ".dsh", "profiles", "sbx", "cordis.patch.yml").replace(/\\/g, "/");
const CANONICAL_PATCH = "# 双星系统沙箱 profile 补丁层：只挂宿主心跳插件。\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function aliveByTasklist(pid) { return pid ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)) : false; }

async function main() {
  const rounds = Math.max(1, Number(process.argv[2] || 8));
  const faults = ["kill", "badpatch", "hbstall"];
  const results = [];

  console.log(`=== 长时韧性演练：${rounds} 轮随机故障注入 ===`);
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  for (const f of [STATE_FILE, HB_FILE, `${STATE}/locks/supervisor.lock`, `${STATE}/journal.jsonl`, `${STATE}/heartbeat/primary.json.tmp`]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} }
  for (const sub of ["snapshots", "logs", "seed", "control"]) {
    const dir = `${STATE}/${sub}`;
    try { for (const n of fs.readdirSync(dir)) fs.rmSync(`${dir}/${n}`, { recursive: true, force: true }); } catch {}
  }
  const pre = readJson(HB_FILE);
  if (pre && pre.pid && aliveByTasklist(pre.pid)) killTree(pre.pid);
  await sleep(2000);

  const sup = spawn(process.execPath, ["src/cli.js", "start"], {
    cwd: ROOT, env: { ...process.env, DSH_BINARY_CONFIG: SANDBOX_CONFIG },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  sup.stdout.on("data", (d) => process.stdout.write(`[supervisor] ${String(d).trim()}\n`));
  sup.stderr.on("data", (d) => process.stderr.write(`[supervisor:err] ${String(d).trim()}\n`));

  // 等首个健康周期
  let ok0 = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = readJson(STATE_FILE);
    const h = readJson(HB_FILE);
    if (st && st.primary.state === "RUNNING" && h && h.health === "ok") { ok0 = true; break; }
  }
  if (!ok0) { console.error("[soak] 监督者未能进入健康基线，终止"); process.exit(2); }
  console.log("[soak] 健康基线就绪\n");

  for (let round = 1; round <= rounds; round++) {
    const fault = faults[Math.floor(Math.random() * faults.length)];
    const h = readJson(HB_FILE);
    const pid = h && h.pid;
    const t0 = Date.now();

    if (fault === "kill") {
      console.log(`[轮 ${round}/${rounds}] 注入 kill（pid=${pid}）`);
      killTree(pid);
    } else if (fault === "badpatch") {
      console.log(`[轮 ${round}/${rounds}] 注入 badpatch（改坏 cordis.patch.yml）`);
      fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH + "\n- insert: [\n    - id: broken\n");
    } else {
      console.log(`[轮 ${round}/${rounds}] 注入 hbstall（心跳 tmp 堵塞）`);
      fs.mkdirSync(`${STATE}/heartbeat/primary.json.tmp`, { recursive: true });
    }

    // 等恢复：state RUNNING + 心跳 ok + pid 变化（kill/hbstall 场景）
    let recovered = false, finalPid = null;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const st = readJson(STATE_FILE);
      const hx = readJson(HB_FILE);
      const downOrWait = st && (st.primary.detail || "").includes("顶班授权");
      if (downOrWait) break; // 阶梯用尽（沙箱无快照可救时正常）——人工复位后继续
      if (st && st.primary.state === "RUNNING" && hx && hx.health === "ok") {
        if (fault === "kill" || fault === "hbstall") { if (hx.pid !== pid) { recovered = true; finalPid = hx.pid; } }
        else recovered = true;
        if (recovered) break;
      }
    }
    const took = Math.round((Date.now() - t0) / 1000);
    // 复位（badpatch 还原 / hbstall 撤除）
    fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
    try { fs.rmdirSync(`${STATE}/heartbeat/primary.json.tmp`); } catch {}
    // 若进入顶班等待，授权+交回回到 normal（保持下一轮基线一致）
    const stNow = readJson(STATE_FILE);
    if (stNow && (stNow.primary.detail || "").includes("顶班授权")) {
      fs.writeFileSync(`${STATE}/control/authorize-takeover.json`, JSON.stringify({ ts: new Date().toISOString(), by: "soak" }));
      for (let i = 0; i < 40; i++) {
        await sleep(5000);
        const st2 = readJson(STATE_FILE);
        if (st2 && st2.satellite.state === "TAKEOVER") break;
      }
      fs.writeFileSync(`${STATE}/control/handback-request.json`, JSON.stringify({ ts: new Date().toISOString(), by: "soak" }));
      for (let i = 0; i < 40; i++) {
        await sleep(5000);
        const st3 = readJson(STATE_FILE);
        const hx = readJson(HB_FILE);
        if (st3 && st3.primary.state === "RUNNING" && st3.satellite.state === "STANDBY" && hx && hx.health === "ok") { recovered = true; break; }
      }
    }
    console.log(`[轮 ${round}] ${recovered ? "✓ 恢复" : "✗ 未恢复"}（${took}s）${finalPid ? ` newPid=${finalPid}` : ""}`);
    results.push({ round, fault, recovered, took });
  }

  // 清理
  console.log("\n=== 清理 ===");
  const hEnd = readJson(HB_FILE);
  if (hEnd && hEnd.pid) killTree(hEnd.pid);
  killTree(sup.pid);
  fs.writeFileSync(SBX_PATCH, CANONICAL_PATCH);
  await sleep(3000);

  // 汇总
  const okN = results.filter((r) => r.recovered).length;
  const times = results.filter((r) => r.recovered).map((r) => r.took);
  console.log(`\n==== SOAK 汇总: ${okN}/${results.length} 轮恢复 ====`);
  if (times.length) {
    console.log(`恢复时间: 平均 ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}s, 最快 ${Math.min(...times)}s, 最慢 ${Math.max(...times)}s`);
  }
  process.exit(okN === results.length ? 0 : 1);
}

main().catch((e) => { console.error("[soak] 异常:", e); process.exit(2); });
