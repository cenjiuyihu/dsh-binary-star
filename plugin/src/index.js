// dsh-binary-star-host — 双星系统宿主插件。
//
// P1：L1 心跳发射器。
// P2：L3 自检（配置干跑式轻量校验）→ 心跳 health 降级上报（degraded），
//     让监督者能识别"进程活但配置被改坏"（事故 1 模式，无需等崩溃）。
//
// 设计要点（企划 §4 / §14.2）：
//  - 心跳文件是卫星/监督者判断主星生死的唯一事实来源（单机文件通信，无网络依赖）；
//  - 心跳必须"宿主进程活着就写"——即使会话层坏了，心跳仍在，
//    由 L2 功能探针 / L3 自检把 health 字段降为非 ok 来暴露功能层故障；
//  - 本插件不依赖任何 dsh 服务（timer/fs 均用 Node 原生），保证最小 profile 也能跑。
//
// 环境变量（由监督者注入）：
//  DSH_BINARY_STATE            状态目录（heartbeat/ 所在处）
//  DSH_BINARY_ROLE             primary | satellite
//  DSH_BINARY_HEARTBEAT_MS     心跳间隔（默认 5000）
//  DSH_BINARY_TOKEN            监督者下发的归属 token（防残留/串扰进程抢写心跳文件）
//  DSH_BINARY_SELFCHECK_PATCH  自检的 patch 文件（相对 DSH_HOME；默认 profiles/web/cordis.patch.yml）
//  DSH_BINARY_SELFCHECK_MS     自检间隔（默认 15000）
import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-binary-star-host'

// 可移植默认值：DSH_HOME 缺省为用户主目录/.dsh（不写死任何用户路径）
const defaultDshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const FALLBACK_STATE = path.join(defaultDshHome, 'binary-star')
const FALLBACK_PATCH = 'profiles/web/cordis.patch.yml'

/** L3 自检：关键文件存在 + patch 结构（insert 块必须有 - id: 行）。零依赖轻量实现。 */
function selfCheck(dshHome, patchRel) {
  const issues = []
  const patch = path.join(dshHome, patchRel)
  if (!existsSync(patch)) {
    issues.push(`patch 文件缺失: ${patchRel}`)
  } else {
    let text = ''
    try { text = readFileSync(patch, 'utf8') } catch { text = '' }
    if (text.includes('insert:')) {
      const hasId = /^\s*- id:/m.test(text)
      if (!hasId) issues.push(`patch 含 insert 块但无任何 - id: 行（${patchRel}）`)
    }
    if (!/\S/.test(text)) issues.push(`patch 文件为空（${patchRel}）`)
  }
  const pkg = path.join(dshHome, 'profiles/web/package.json')
  if (existsSync(pkg)) {
    try { JSON.parse(readFileSync(pkg, 'utf8')) } catch { issues.push('profiles/web/package.json 不是合法 JSON') }
  }
  return issues
}

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || defaultDshHome
  const stateDir = process.env.DSH_BINARY_STATE || FALLBACK_STATE
  const role = process.env.DSH_BINARY_ROLE || 'primary'
  const intervalMs = Number(process.env.DSH_BINARY_HEARTBEAT_MS || 5000)
  const selfCheckMs = Number(process.env.DSH_BINARY_SELFCHECK_MS || 15000)
  const patchRel = process.env.DSH_BINARY_SELFCHECK_PATCH || FALLBACK_PATCH
  const token = process.env.DSH_BINARY_TOKEN || 'none'
  const dir = path.join(stateDir, 'heartbeat')
  const file = path.join(dir, `${role}.json`)
  const bootTs = Date.now()

  // L3 自检结果缓存（每次心跳写时带上）
  let lastHealth = 'ok'
  let lastDetail = null

  const runSelfCheck = () => {
    try {
      const issues = selfCheck(dshHome, patchRel)
      lastHealth = issues.length === 0 ? 'ok' : 'degraded'
      lastDetail = issues.length === 0 ? null : issues.join('; ')
    } catch (err) {
      lastHealth = 'degraded'
      lastDetail = `自检异常: ${err.message}`
    }
  }
  runSelfCheck()

  const write = () => {
    try {
      mkdirSync(dir, { recursive: true })
      const hb = {
        role,
        pid: process.pid,
        status: 'RUNNING',
        health: lastHealth,
        detail: lastDetail,
        ts: Date.now(),
        bootTs,
        token,
        version: 2,
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(hb))
      renameSync(tmp, file)
    } catch (err) {
      // 心跳写失败不能炸掉宿主进程；留给监督者按"无心跳"处置
      try { console.error(`[binary-star] heartbeat write failed: ${err.message}`) } catch {}
    }
  }

  ctx.effect(() => {
    write()
    const hbTimer = setInterval(write, intervalMs)
    const scTimer = setInterval(runSelfCheck, selfCheckMs)
    return () => {
      clearInterval(hbTimer)
      clearInterval(scTimer)
    }
  })
}
