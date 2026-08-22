"use strict";
/**
 * 嵌套复现：像 drill-loop.js 一样 spawn `node src/cli.js start`，观察首轮主星是否死亡。
 * 用法: node scripts/diag-nested.js [--no-config-env]
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PROJECT = "D:/DSH/binary-star";
const HB_FILE = "C:/Users/cxm20/.dsh/binary-star-sbx/heartbeat/primary.json";
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const noConfigEnv = process.argv.includes("--no-config-env");
  console.log(`[diag] spawn cli.js start (noConfigEnv=${noConfigEnv})`);
  const env = noConfigEnv ? { ...process.env } : { ...process.env, DSH_BINARY_CONFIG: "D:/DSH/.binary-star/config.sandbox.json" };
  const sup = spawn(process.execPath, ["src/cli.js", "start"], { cwd: PROJECT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  sup.stdout.on("data", (d) => process.stdout.write(`[cli:out] ${String(d).trimEnd()}\n`));
  sup.stderr.on("data", (d) => process.stdout.write(`[cli:err] ${String(d).trimEnd()}\n`));

  const t0 = Date.now();
  let lastPid = null, died = null;
  while (Date.now() - t0 < 40000) {
    await sleep(1000);
    const h = readJson(HB_FILE);
    if (h && h.pid !== lastPid) {
      console.log(`[diag] t+${Math.round((Date.now() - t0) / 1000)}s hb.pid=${h.pid} age=${Math.round((Date.now() - h.ts) / 1000)}s health=${h.health}`);
      lastPid = h.pid;
    }
    // 进程是否还活着（tasklist 判定，绕开任何 process.kill 疑云）
    const { spawnSync } = require("node:child_process");
    const tl = spawnSync("tasklist", ["/FI", `PID eq ${h ? h.pid : 0}`, "/NH"], { encoding: "utf8" }).stdout;
    const aliveNow = h ? tl.includes(String(h.pid)) : false;
    if (lastPid && !aliveNow && !died) {
      died = h.pid;
      console.log(`[diag] t+${Math.round((Date.now() - t0) / 1000)}s ★ 主星 ${died} 死亡（tasklist 不再匹配）`);
    }
    if (sup.exitCode !== null && !died) {
      died = "cli";
      console.log(`[diag] t+${Math.round((Date.now() - t0) / 1000)}s ★ cli.js 退出 code=${sup.exitCode}`);
    }
  }
  const h = readJson(HB_FILE);
  console.log(`[diag] 40s 结束: cliExit=${sup.exitCode} lastHbPid=${h && h.pid} died=${died}`);
  const { spawnSync } = require("node:child_process");
  if (h && h.pid) spawnSync("taskkill", ["/PID", String(h.pid), "/T", "/F"], { stdio: "ignore" });
  if (sup.exitCode === null) spawnSync("taskkill", ["/PID", String(sup.pid), "/T", "/F"], { stdio: "ignore" });
  process.exit(0);
}

main();
