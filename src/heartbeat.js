"use strict";
/**
 * 双星系统：心跳（L1 检测线）。
 * 主星宿主插件每 intervalMs 写一次 heartbeat/<role>.json；
 * 看门狗（监督者/卫星）每 watchIntervalMs 读一次，用 missThreshold 判死。
 * 功能探针（L2）把结果写进 health 字段：ok | session-fail | degraded | unknown。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 写心跳（供宿主插件调用；PID 自动取当前进程） */
function writeHeartbeat(heartbeatDir, role, { status = "RUNNING", health = "ok", detail = null } = {}) {
  const hb = {
    role,
    pid: process.pid,
    status,
    health,
    detail,
    ts: Date.now(),
    bootTs: global.__DSH_BOOT_TS__ || Date.now(),
  };
  const file = path.join(heartbeatDir, `${role}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hb));
  fs.renameSync(tmp, file);
  return hb;
}

/** 读心跳；文件缺失返回 null */
function readHeartbeat(heartbeatDir, role) {
  try {
    return JSON.parse(fs.readFileSync(path.join(heartbeatDir, `${role}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** 心跳是否过期（按 missThreshold × watchIntervalMs 估算窗口） */
function isStale(hb, { missThreshold, watchIntervalMs }, now = Date.now()) {
  if (!hb) return true;
  const windowMs = (missThreshold || 3) * (watchIntervalMs || 10000);
  return now - hb.ts > windowMs;
}

/** 进程是否存活（Windows 下用 taskkill 兜底前先做 PID 探测） */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但无权信号
  }
}

/** 心跳是否可信（归属权校验：必须携带监督者下发的 token，防残留/串扰进程抢写） */
function isTrusted(hb, token) {
  if (!hb) return false;
  if (!token) return true; // 无 token 模式（兼容未启用监督者的环境）
  return hb.token === token;
}

/** 心跳内容摘要（用于状态展示） */
function summarize(hb) {
  if (!hb) return "(无心跳)";
  const age = Math.round((Date.now() - hb.ts) / 1000);
  return `${hb.role}#${hb.pid} status=${hb.status} health=${hb.health} age=${age}s`;
}

module.exports = { writeHeartbeat, readHeartbeat, isStale, isPidAlive, isTrusted, summarize };
