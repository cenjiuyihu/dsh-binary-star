"use strict";
/**
 * 卫星副本 profile 自动化准备（幂等，可重复运行）。
 *
 * 目的：顶班（failover）需要 profiles/satellite —— web bundles + 自有最小 patch。
 * 本脚本一键完成：package.json（bundles + link 依赖）→ cordis.yml → cordis.patch.yml
 * → node_modules 两个 junction（@deepseek-ai 复用主星依赖树 / dsh-binary-star-host
 * 指向本项目 plugin）→ --dump-config 冒烟验证。
 *
 * 可移植：路径均在运行时推导（HOME = 用户主目录，PLUGIN = 本项目 plugin/），
 * 也可用 DSH_SETUP_PROFILE / DSH_SETUP_DSH_HOME / DSH_SETUP_BIN 覆盖。
 *
 * 用法: node scripts/setup-satellite.js
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const HOME = os.homedir();
const DSH_HOME = process.env.DSH_SETUP_DSH_HOME || path.join(HOME, ".dsh");
const PROFILE = process.env.DSH_SETUP_PROFILE || "satellite";
const PROFILE_DIR = path.join(DSH_HOME, "profiles", PROFILE);
const WEB_NM = path.join(DSH_HOME, "profiles", "web", "node_modules");
const BIN = process.env.DSH_SETUP_BIN || path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PLUGIN = path.join(__dirname, "..", "plugin");

const PACKAGE_JSON = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dependencies: {
    "dsh-binary-star-host": `link:${PLUGIN.replace(/\\/g, "/")}`,
  },
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    },
  },
};
const CORDIS_YML = "# dsh profile root \u2014 an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
const PATCH_YML = `# \u53cc\u661f\u7cfb\u7edf\u536b\u661f profile \u8865\u4e01\u5c42\uff1a\u53ea\u6302\u5bbf\u4e3b\u5fc3\u8df3\u63d2\u4ef6\uff08DSH_BINARY_ROLE=satellite \u65f6\u5199 satellite.json\uff09\u3002\n- insert:\n    - id: binary-star-host\n      name: dsh-binary-star-host\n`;

function mkdirP(dir) { fs.mkdirSync(dir, { recursive: true }); }

function ensureJunction(junction, target, label, isScope = false) {
  // scope 目录（如 @deepseek-ai）没有根 package.json，存在性探测只看目录本身
  const probe = isScope ? junction : path.join(junction, "package.json");
  if (fs.existsSync(probe) || fs.existsSync(junction)) {
    // 已存在（文件/目录/junction）→ 校验指向
    try {
      const t = fs.readlinkSync(junction);
      if (t.replace(/\\/g, "/").toLowerCase() === target.replace(/\\/g, "/").toLowerCase()) {
        console.log(`[ok] ${label} junction 已存在且指向正确`);
        return true;
      }
      console.error(`[!] ${label} junction 存在但指向 ${t}（期望 ${target}），请人工检查`);
      return false;
    } catch {
      console.error(`[!] ${label} 路径已存在但不是 junction，请人工检查: ${junction}`);
      return false;
    }
  }
  mkdirP(path.dirname(junction));
  const r = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `New-Item -ItemType Junction -Path "${junction}" -Target "${target}" -Force | Out-Null`,
  ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) { console.error(`[!] ${label} junction 创建失败: ${String(r.stderr || r.stdout).trim()}`); return false; }
  if (!fs.existsSync(probe)) { console.error(`[!] ${label} junction 创建后校验失败`); return false; }
  console.log(`[ok] ${label} junction 已创建 → ${target}`);
  return true;
}

function dumpConfig(profile) {
  if (!fs.existsSync(BIN)) { console.error(`[!] dsh bin.js 不存在: ${BIN}（可用 DSH_SETUP_BIN 覆盖）`); return null; }
  return spawnSync(process.execPath, [BIN, "--profile", profile, "--dump-config"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
}

console.log(`=== \u536b\u661f\u526f\u672c profile \u81ea\u52a8\u5316\uff08${PROFILE} @ ${DSH_HOME}）===`);

// 1) 预检：web 组合树必须健康（依赖树来源）
const base = dumpConfig("web");
if (!base || base.status !== 0) { console.error("[!] 预检失败：web profile 组合树不可解析（或 dsh 路径无效），先修复再准备卫星"); process.exit(2); }
if (!fs.existsSync(PLUGIN)) { console.error(`[!] 项目 plugin 目录不存在: ${PLUGIN}`); process.exit(2); }
console.log("[1/5] 预检通过（web 组合树健康，plugin 存在）");

// 2) profile 目录与三个配置文件（幂等写）
mkdirP(PROFILE_DIR);
fs.writeFileSync(path.join(PROFILE_DIR, "package.json"), JSON.stringify(PACKAGE_JSON, null, 2) + "\n");
fs.writeFileSync(path.join(PROFILE_DIR, "cordis.yml"), CORDIS_YML);
fs.writeFileSync(path.join(PROFILE_DIR, "cordis.patch.yml"), PATCH_YML);
console.log("[2/5] package.json / cordis.yml / cordis.patch.yml 已写入");

// 3) node_modules junction ×2（幂等）
const NM = path.join(PROFILE_DIR, "node_modules");
mkdirP(NM);
const j1 = ensureJunction(path.join(NM, "@deepseek-ai"), path.join(WEB_NM, "@deepseek-ai"), "@deepseek-ai", true);
const j2 = ensureJunction(path.join(NM, "dsh-binary-star-host"), PLUGIN, "dsh-binary-star-host");
if (!j1 || !j2) process.exit(1);
console.log("[3/5] node_modules junction 就绪");

// 4) 冒烟验证：satellite 组合树必须可解析
const after = dumpConfig(PROFILE);
if (!after || after.status !== 0) {
  console.error(`[!] 验证失败：${PROFILE} 组合树不可解析——请检查上方输出`);
  process.exit(1);
}
const hasHost = after.stdout.includes("binary-star-host");
if (!hasHost) { console.error("[!] 验证失败：组合树不含 binary-star-host 行"); process.exit(1); }
console.log("[4/5] 验证通过：satellite 组合树健康（含 binary-star-host）");

// 5) 收尾
console.log("[5/5] 卫星副本 profile 就绪 ✅");
console.log(`  顶班实例将使用: --profile ${PROFILE}（工作区/端口见 config 的 takeover.*）`);
console.log("  重跑：本脚本幂等，可随时重新执行；删除 profiles/satellite 目录即回滚。");
