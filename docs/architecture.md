# 架构说明

## 角色

| 角色 | 实现 | 职责 | 依赖 LLM |
|---|---|---|---|
| 主星 | 你的 DSH web profile | 干活；写心跳/账本；L3 自检 | — |
| 监督者 | `src/supervisor.js`（独立进程） | 监视/分类/重启/修复阶梯/受控重启/顶班/交回 | 否（纯机制） |
| 卫星副本 | `profiles/satellite`（web bundles + 自有最小 patch） | 顶班环境：GUI + 修复智能体 + 会话种子 | 代班对话时 |

## 模块

```
src/
  paths.js      配置（占位符 $HOME/$CWD/$NPM_ROOT）+ 命令构造 + 日志
  state.js      双星状态机持久化（state.json）
  heartbeat.js  心跳写读/判死/进程探测/归属 token 校验
  probe.js      探针：进程 + HTTP + 心跳 health（可绑定期望 pid，防假阳性）
  journal.js    变更账本（open/commit/reverted；自我修改协议）
  snapshot.js   保护范围快照/还原
  seed.js       会话种子提取（多帧 zstd 解压 + 最近 N 条消息）
  ladder.js     修复阶梯（0-6，每步动作→重启→pid 绑定验证；写修复报告）
  supervisor.js 监督者状态机（含受控关闭/孤儿检测/代班接管/交回）
  cli.js        dsh-binary CLI
plugin/
  index.js      宿主插件：L1 心跳 + L3 自检（零服务依赖，可挂任意 profile）
```

## 检测三线与故障分类

- **L1 心跳**：主星每 5s 原子写 `heartbeat/primary.json`（pid/health/token）；监督者每 10s 检查，30s 无更新判可疑
- **L2/L3**：L3 自检（配置结构）在心跳 `health` 字段上报 `degraded`；组合树冒烟（`--dump-config`）在修复阶梯中作为决定性判据
- **分类**：D1 启动失败 / D2 功能性故障（health≠ok）/ D3 挂死（进程在心跳停）/ BOOT_GRACE（启动宽限，宽限期内退出≥2 次提前结束）

## 修复阶梯

| 步 | 动作 | 说明 |
|---|---|---|
| 0 | 强杀重启 | 偶发崩溃 |
| 1 | 配置校验 | `--dump-config` 组合树冒烟 |
| 2 | 回滚 open 账目 | 改到一半崩溃的头号嫌疑 |
| 3 | 回滚最近 committed 账目 | 改完才炸 |
| 4 | 快照还原 | 破坏性，默认需人工确认 |
| 5 | 重装 last-known-good dsh 版本 | 破坏性，需确认 |
| 6 | 顶班 | 交给卫星副本 |

每步"动作 → 重启 → pid 绑定探针验证"，成功即停；执行记录写 `logs/repair/<ts>.json`。

## 受控自重启验证

`control/restart-request.json`（含账目 id）→ 监督者受控重启 → 探针验证：
通过 → 清除请求；失败 → 阶梯回滚；3 次失败 → 标记 `.failed` 停止自动重试。

## 顶班与交回

阶梯用尽 → 顶班等待（`control/authorize-takeover.json` 或超时自动）→
会话种子（读主星最新会话，多帧 zstd 解压，取最近 N 条 → `seed/latest.txt`）→
卫星副本 profile 顶班（GUI + 修复智能体 + 种子续接）→
`control/handback-request.json` → 停代班 → 代班会话归档入主星会话列表 → 主星重启。

## 进程生命周期与安全

- **归属 token**：监督者每次启动生成，注入子进程；心跳必须携带才算可信（防残留进程抢写）
- **单实例锁**：`locks/supervisor.lock`（pid 存活检测 + 自动接管）
- **受控关闭**：`control/shutdown` → 监督者停主星→释放锁→退出（不复活）
- **孤儿检测**：`DSH_BINARY_PARENT_PID` 指向的父进程死亡 → 监督者自清理（防后台残留）
- **启动接管**：监督者启动时若发现已在运行的主星（如桌面壳拉起），执行一次性交接（杀旧→拉起带 token 新实例）

## 边界（保护范围 vs 禁区）

- 修复范围：profiles 组合文件、profiles/plugins、settings.yaml、dsh 包版本
- 永不触碰：sessions/（只读用于种子）、storages/、.credentials.yaml、用户工作区、ui-patch
