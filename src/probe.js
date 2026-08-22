"use strict";
/**
 * 双星系统：功能探针（L2 检测线）。
 * 只查"进程活着"不够，必须查"会话层能不能用"：
 *  - HTTP 层：GET 主星端口（GUI 可达）
 *  - 心跳层：health 字段（宿主插件自报：ok | session-fail | degraded）
 */
const http = require("node:http");
const hb = require("./heartbeat");

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs || 3000, () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, error: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, statusCode: 0, error: e.code || e.message }));
  });
}

/**
 * 检查主星：进程 / HTTP / 心跳 health 三合一。
 * expectedPid：验证必须绑定"本次重启的新进程"——旧进程的心跳即使还在新鲜窗口内
 * 也不能算数（受控自重启/快速路径的假阳性根因）。
 */
async function probePrimary(cfg, paths_, stateFile, expectedPid) {
  const heartbeat = hb.readHeartbeat(paths_.heartbeat, "primary");
  const trusted = hb.isTrusted(heartbeat, cfg.token);
  const pidMatch = !expectedPid || (heartbeat && heartbeat.pid === expectedPid);
  const alive = trusted && pidMatch ? hb.isPidAlive(heartbeat.pid) : false;
  const httpCheck = cfg.probe ? cfg.probe.httpCheck !== false : true;
  const httpResult = httpCheck
    ? await httpGet(`http://127.0.0.1:${cfg.primaryPort}/`, cfg.fastPath.probeTimeoutMs || 3000)
    : { ok: true, statusCode: 0, httpDisabled: true };
  return {
    alive,
    pidMatch,
    httpOk: httpResult.ok,
    httpStatus: httpResult.statusCode,
    heartbeat,
    trusted,
    health: trusted && heartbeat ? heartbeat.health : "unknown",
    stale: !trusted || hb.isStale(heartbeat, cfg.heartbeat),
    ok: alive && httpResult.ok && heartbeat && trusted && pidMatch &&
      !hb.isStale(heartbeat, cfg.heartbeat) && heartbeat.health === "ok",
  };
}

/** 轮询等待 HTTP 就绪（代班实例启动验证用） */
function waitForHttp(url, timeoutMs, intervalMs = 3000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      const r = await httpGet(url, 2000);
      if (r.ok) return resolve({ ok: true, statusCode: r.statusCode });
      if (Date.now() > deadline) return resolve({ ok: false, statusCode: r.statusCode, error: "timeout" });
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { probePrimary, httpGet, waitForHttp };
