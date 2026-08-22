"use strict";
/**
 * 部署后验收（只读，可重复运行）。
 * 本机路径均可 env 覆盖（DSH_VERIFY_*）。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const BIN = process.env.DSH_VERIFY_BIN || ""; // 留空则从 $NPM_ROOT 推导
const PATCH = process.env.DSH_VERIFY_PATCH || path.join(DSH_HOME, "profiles/web/cordis.patch.yml");
const JUNCTION = process.env.DSH_VERIFY_JUNCTION || path.join(DSH_HOME, "profiles/web/node_modules/dsh-binary-star-host");
const PLUGIN = process.env.DSH_VERIFY_PLUGIN || "";
const HB = process.env.DSH_VERIFY_HB || path.join(DSH_HOME, "binary-star/heartbeat/primary.json");
const STATE = process.env.DSH_VERIFY_STATE || path.join(DSH_HOME, "binary-star/state.json");
const CWD = process.env.DSH_VERIFY_CWD || "D:/DSH";

function resolveBin() {
  if (BIN) return BIN;
  const comSpec = process.env.ComSpec || "cmd.exe";
  const r = spawnSync(comSpec, ["/c", "npm.cmd root -g"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const root = r.status === 0 ? String(r.stdout || "").trim().split(/\r?\n/)[0] : "";
  return root ? path.join(root, "@deepseek-ai", "dsh", "lib", "bin.js") : "";
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
};

console.log("=== 双星系统部署验收（只读）===");

// 1) 组合树健康且含新行
const bin = resolveBin();
if (!bin) {
  check("解析 dsh bin.js 路径", false, "npm root -g 失败，请用 DSH_VERIFY_BIN 指定");
} else {
  const dump = spawnSync(process.execPath, [bin, "web", "--dump-config"], {
    cwd: CWD, encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
  });
  check("web 组合树可解析（dump-config 退出 0）", dump.status === 0, `status=${dump.status}`);
  check("组合树含 binary-star-host 行", dump.status === 0 && dump.stdout.includes("binary-star-host"));
}

// 2) junction
const jExists = fs.existsSync(path.join(JUNCTION, "package.json"));
check("web/node_modules junction 就绪", jExists, JUNCTION);

// 3) patch 行
const patchText = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, "utf8") : "";
check("cordis.patch.yml 含 binary-star-host 行", patchText.includes("binary-star-host"));

// 4) 状态（监督者未运行时 state.json 不存在属预期）
let hb = null, st = null;
try { hb = JSON.parse(fs.readFileSync(HB, "utf8")); } catch {}
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
check("主星心跳文件存在", !!hb, HB);
if (hb) {
  const age = Math.round((Date.now() - hb.ts) / 1000);
  check("心跳健康（health=ok）", hb.health === "ok", `health=${hb.health}`);
  check("心跳新鲜（≤60s）", age <= 60, `age=${age}s`);
  if (hb.token && hb.token !== "none") {
    check("心跳带归属 token", true, hb.token);
  } else {
    console.log("[note] 心跳 token=none（监督者未启动，属预期）");
  }
}
if (st) {
  check("状态文件存在", true, STATE);
  check("主星状态 RUNNING", st.primary.state === "RUNNING", st.primary.state);
} else {
  console.log("[note] state.json 不存在（监督者未启动，属预期）");
}

console.log(`\n==== 部署验收: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
