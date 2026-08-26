"use strict";
/**
 * P5 上线后验收（只读，可重复运行）：
 * 检查真实部署的 4 项关键状态，全部 PASS 即上线成功。
 *
 * 本脚本不含硬编码绝对路径：默认值均在运行时推导
 * （HOME = 用户主目录；BIN = npm 全局目录下的 dsh bin.js；PLUGIN = 本仓库 plugin/），
 * 也可用 DSH_VERIFY_* 环境变量覆盖。
 *
 * 用法: node scripts/verify-live.js
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, ".dsh");
const BIN = process.env.DSH_VERIFY_BIN || path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PATCH = process.env.DSH_VERIFY_PATCH || path.join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
const JUNCTION = process.env.DSH_VERIFY_JUNCTION || path.join(DSH_HOME, "profiles", "web", "node_modules", "dsh-binary-star-host");
const PLUGIN = process.env.DSH_VERIFY_PLUGIN || path.join(__dirname, "..", "plugin");
const HB = process.env.DSH_VERIFY_HB || path.join(DSH_HOME, "binary-star", "heartbeat", "primary.json");
const STATE = process.env.DSH_VERIFY_STATE || path.join(DSH_HOME, "binary-star", "state.json");
const CWD = process.env.DSH_VERIFY_CWD || process.cwd();

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
};

console.log("=== 双星系统上线验收（只读）===");

// 1) 组合树健康且含新行
const dump = spawnSync(process.execPath, [BIN, "web", "--dump-config"], {
  cwd: CWD, encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
});
check("web 组合树可解析（dump-config 退出 0）", dump.status === 0, `status=${dump.status}`);
check("组合树含 binary-star-host 行", dump.status === 0 && dump.stdout.includes("binary-star-host"));

// 2) junction
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
const jExists = fs.existsSync(path.join(JUNCTION, "package.json"));
const jTarget = (() => {
  try { return fs.readlinkSync(JUNCTION); } catch { return null; }
})();
check("web/node_modules junction 就绪", jExists, JUNCTION);
// 双向归一化（\ 与 /）后再比较，避免 Windows 上 f:/ vs f:\ 误报
check("junction 指向插件目录", jTarget && norm(jTarget) === norm(PLUGIN), String(jTarget));

// 3) patch 行
const patchText = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, "utf8") : "";
check("cordis.patch.yml 含 binary-star-host 行", patchText.includes("binary-star-host"));

// 4) 状态（监督者未运行时 state.json 不存在属预期——状态由监督者维护）
let hb = null, st = null;
try { hb = JSON.parse(fs.readFileSync(HB, "utf8")); } catch {}
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
check("主星心跳文件存在", !!hb, HB);
if (hb) {
  const age = Math.round((Date.now() - hb.ts) / 1000);
  check("心跳健康（health=ok）", hb.health === "ok", `health=${hb.health}`);
  check("心跳新鲜（≤60s）", age <= 60, `age=${age}s`);
  // 监督者未启动时 token='none' 属预期（归属校验由监督者下发 token 时生效）
  if (hb.token && hb.token !== "none") {
    check("心跳带归属 token", true, hb.token);
  } else {
    console.log("[note] 心跳 token=none（监督者未启动，属预期；启动监督者后将带 token）");
  }
}
if (st) {
  check("状态文件存在", true, STATE);
  check("主星状态 RUNNING", st.primary.state === "RUNNING", st.primary.state);
} else {
  console.log("[note] state.json 不存在（监督者未启动，属预期；启动监督者后自动生成）");
}

console.log(`\n==== 上线验收: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
