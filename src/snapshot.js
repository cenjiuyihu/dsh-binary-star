"use strict";
/**
 * 双星系统：快照（副本/还原基础）。
 * 只快照保护范围（config.default.json 的 snapshot.scope，相对 DSH_HOME），
 * 明确排除 node_modules/dist/.git 与 sessions/storages/credentials（不在 scope 内）。
 * 快照同时记录 dsh 版本与 ui-patch 状态，作为 last-known-good 的旁证。
 */
const fs = require("node:fs");
const path = require("node:path");

function dshVersion(dshPkg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dshPkg, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** 是否应排除（目录名匹配） */
function isExcluded(rel, excludes) {
  return excludes.some((x) => rel === x || rel.endsWith(`/${x}`) || rel.includes(`/${x}/`));
}

/** 拷贝单个文件/目录（递归，跳过 excludes） */
function copyScopeItem(src, dest, rel, excludes) {
  if (isExcluded(rel, excludes)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyScopeItem(path.join(src, child), path.join(dest, child), `${rel}/${child}`, excludes);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** 打快照：tag ∈ {baseline, pre, daily, manual}；返回快照目录 */
function snapshotScope(cfg, paths_, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(paths_.snapshots, `${tag}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const scope = cfg.snapshot.scope || [];
  const copied = [];
  for (const rel of scope) {
    const src = path.join(cfg.dshHome, rel);
    if (!fs.existsSync(src)) continue;
    copyScopeItem(src, path.join(dir, rel), rel, cfg.snapshot.exclude || []);
    copied.push(rel);
  }
  const meta = {
    tag,
    ts: new Date().toISOString(),
    dshVersion: dshVersion(cfg.dshPkg),
    uiPatchApplied: !!(cfg.uiPatch && cfg.uiPatch.backup && fs.existsSync(cfg.uiPatch.backup)),
    copied,
    scope,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return { dir, meta };
}

/** 列出快照（按时间倒序；只认带 meta.json 的真实快照，账本备份目录 pre-* 自动忽略） */
function listSnapshots(paths_) {
  if (!fs.existsSync(paths_.snapshots)) return [];
  return fs
    .readdirSync(paths_.snapshots)
    .filter((n) => {
      const dir = path.join(paths_.snapshots, n);
      if (!fs.statSync(dir).isDirectory()) return false;
      return fs.existsSync(path.join(dir, "meta.json"));
    })
    .sort()
    .reverse()
    .map((n) => {
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(paths_.snapshots, n, "meta.json"), "utf8"));
      } catch {}
      return { name: n, meta };
    });
}

/** 从快照还原保护范围（破坏性：调用方需确认） */
function restoreSnapshot(cfg, paths_, snapshotName) {
  const src = path.join(paths_.snapshots, snapshotName);
  if (!fs.existsSync(src)) throw new Error(`快照不存在: ${snapshotName}`);
  const metaFile = path.join(src, "meta.json");
  if (!fs.existsSync(metaFile)) throw new Error(`不是有效快照（缺 meta.json）: ${snapshotName}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const restored = [];
  for (const rel of meta.copied || []) {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(cfg.dshHome, rel);
    fs.rmSync(to, { recursive: true, force: true });
    copyScopeItem(from, to, rel, []);
    restored.push(rel);
  }
  return { restored, meta };
}

module.exports = { snapshotScope, listSnapshots, restoreSnapshot, dshVersion };
