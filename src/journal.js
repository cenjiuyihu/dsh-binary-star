"use strict";
/**
 * 双星系统：变更账本（journal.jsonl，每行一条）。
 * 账目是修复的第一依据：崩溃 = 留下一笔 open 账目 = 头号嫌疑。
 *
 * 条目 schema：
 * { id, ts, actor, desc, scope, backup, recipe, status, verify, restartRequired }
 */
const fs = require("node:fs");
const path = require("node:path");

function readEntries(journalFile) {
  try {
    const text = fs.readFileSync(journalFile, "utf8");
    if (!text.trim()) return [];
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendEntry(journalFile, entry) {
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.appendFileSync(journalFile, JSON.stringify(entry) + "\n");
  return entry;
}

function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^J-(\d+)$/.exec(e.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `J-${String(max + 1).padStart(6, "0")}`;
}

/** 开启一笔账目（自我修改协议第 1 步） */
function openEntry(journalFile, { actor, desc, scope = [], backup = null, recipe = null, verify = null, restartRequired = false }) {
  const entries = readEntries(journalFile);
  const entry = {
    id: nextId(entries),
    ts: new Date().toISOString(),
    actor: actor || "unknown",
    desc,
    scope,
    backup,
    recipe,
    status: "open",
    verify,
    restartRequired,
  };
  appendEntry(journalFile, entry);
  return entry;
}

/** 提交账目（验证通过后） */
function commitEntry(journalFile, id) {
  const lines = fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean);
  const out = [];
  let hit = false;
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.id === id && e.status === "open") {
      e.status = "committed";
      e.committedAt = new Date().toISOString();
      hit = true;
    }
    out.push(JSON.stringify(e));
  }
  if (!hit) throw new Error(`账目 ${id} 不存在或已非 open 状态`);
  fs.writeFileSync(journalFile, out.join("\n") + "\n");
}

/** 标记回滚（修复阶梯使用） */
function markReverted(journalFile, id, detail) {
  const lines = fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean);
  const out = [];
  let hit = false;
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.id === id && e.status !== "reverted") {
      e.status = "reverted";
      e.revertedAt = new Date().toISOString();
      e.revertDetail = detail || null;
      hit = true;
    }
    out.push(JSON.stringify(e));
  }
  if (!hit) throw new Error(`账目 ${id} 不存在`);
  fs.writeFileSync(journalFile, out.join("\n") + "\n");
}

/** 为账目补充 backup 字段 */
function setBackup(journalFile, id, backup) {
  const lines = fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean);
  const out = [];
  let hit = false;
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.id === id) {
      e.backup = backup;
      hit = true;
    }
    out.push(JSON.stringify(e));
  }
  if (!hit) throw new Error(`账目 ${id} 不存在`);
  fs.writeFileSync(journalFile, out.join("\n") + "\n");
}

/** 未结账目（头号嫌疑） */
function findOpen(entries) {
  return entries.filter((e) => e.status === "open");
}

/** 最近 N 条 committed（修复阶梯第 3 步的候选） */
function recentCommitted(entries, n = 10) {
  return entries.filter((e) => e.status === "committed").slice(-n).reverse();
}

module.exports = { readEntries, openEntry, commitEntry, markReverted, setBackup, findOpen, recentCommitted, nextId };
