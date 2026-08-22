"use strict";
/**
 * 双星系统：双星状态机持久化（state.json）。
 * 主星: RUNNING / DEGRADED / FROZEN / DOWN / VERIFYING / HANDED-BACK
 * 卫星: STANDBY / DIAGNOSING / REPAIRING / VERIFYING / TAKEOVER
 * 监督者: SUPERVISING（恒定）
 */
const fs = require("node:fs");
const path = require("node:path");

function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    supervisor: { state: "SUPERVISING", startedAt: null },
    primary: { state: "DOWN", since: null, lastHeartbeatAt: null, detail: null },
    satellite: { state: "STANDBY", since: null, lastHeartbeatAt: null, detail: null },
    lastRepair: null,
    rate: { restartsThisHour: 0, restoresThisHour: 0, hourStart: null },
  };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return emptyState();
  }
}

/** 原子写（临时文件 + 改名），避免半写状态 */
function writeState(stateFile, st) {
  st.updatedAt = new Date().toISOString();
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, stateFile);
}

function setState(stateFile, st, role, newState, detail) {
  st[role].state = newState;
  st[role].since = new Date().toISOString();
  st[role].detail = detail || null;
  writeState(stateFile, st);
  return st;
}

module.exports = { emptyState, readState, writeState, setState };
