# dsh-binary-star 双星系统

让 DeepSeek Harness (DSH) 智能体拥有"把自己搞坏后能自己修好"的能力：
**主星干活，卫星（副本 profile）待命，监督者（纯 Node、无 LLM）负责监视、修复、顶班。**

> 本项目由 AI 辅助开发。适用 Windows；dsh 版本 0.1.1-rc.2（已验证 0.1.0-rc.7 → rc.8 → 0.1.1-rc.2 连续升级）。

## 特性

- **三线检测**：L1 心跳（进程层）/ L3 自检（配置被改坏未崩溃即上报 degraded）/ 组合树冒烟（`--dump-config`）
- **变更账本**：自我修改先记账（`journal open/commit/rollback`），崩溃 = 一笔 open 账目 = 修复头号嫌疑
- **修复阶梯**（0-6，每步验证、成功即停）：重启 → 校验 → 回滚账目 → 快照还原 → 重装 → 顶班；每次执行写结构化修复报告
- **受控自重启验证**：需重启生效的修改 → 受控重启 → 探针验证 → 失败自动回滚（根治"装完重启后全废"）
- **代班接管（failover）**：阶梯用尽 → 授权/超时 → 卫星副本 profile 顶班（GUI + 修复智能体 + 会话种子续接）→ 交回时会话归档
- **70+ 项沙箱演练**（`scripts/drill-*.js`）：故意搞炸系统来证明它能修
- **一键运维脚本**：`setup-satellite.js`（卫星副本自动准备）/ `upgrade-dsh.js`（版本升级+失败自动回滚）/ `soak.js`（长时随机故障韧性测试）
- **桌面壳监视器 v2**：事件流 / 日志查看 / 修复历史与统计 / 失败告警横幅 / 监督者崩溃自动重启（看门狗）/ 系统通知

## 架构

```
用户/GUI :3080 ─► 主星（web profile：心跳/自检/账本）
                    │ 文件级通信（心跳/控制文件，无网络依赖）
监督者（独立进程，无 LLM）── 监视 → 分类(D1-D4) → 快速重启 → 修复阶梯
                    │ → 受控自重启验证 → 顶班等待 → 代班接管 → 交回归档
卫星副本（satellite profile：web bundles + 自有 patch，永不自我修改 → 永远可启动）
```

- **三角色**：主星（干活）、监督者（机制中枢）、卫星（副本环境）
- **全部通信是文件**：单机设计，主星网络挂了不影响监督者判断
- **保护范围**：只修 profiles 组合/plugins/settings.yaml/dsh 包版本；绝不碰 sessions/storages/credentials/用户工作区

## 快速开始

前置：Node.js >= 20、全局安装 `@deepseek-ai/dsh`（本项目适配 0.1.1-rc.2）。

```bash
# 1. 部署宿主插件到真实 web profile（自动备份 + 验证，可回滚）
node scripts/deploy-live.js

# 2. 验收（只读 11 项检查）
node scripts/verify-live.js
```

## 命令

| 命令 | 说明 |
|---|---|
| `node src/cli.js start` | 启动监督者（拉起主星并监视；卫星在 P2 接入） |
| `node src/cli.js status` | 双星状态一览 |
| `node src/cli.js stop` | 停掉监督者拉起的双星进程树 |
| `node src/cli.js snapshot <tag>` | 打快照（baseline/pre/daily/manual） |
| `node src/cli.js repair --now` | 手动触发修复阶梯 |
| `node src/cli.js halt` | 暂停自动修复 |
| `node src/cli.js journal <open\|commit\|rollback\|list>` | 变更账本 |
| `node src/cli.js takeover --now\|--undo` | 人工授权顶班 / 请求交回 |
| `node scripts/setup-satellite.js` | 卫星副本 profile 自动准备（幂等） |
| `node scripts/upgrade-dsh.js <版本>` | dsh 升级 + 验证（失败自动回滚） |
| `node scripts/soak.js [轮数]` | 长时随机故障韧性测试 |

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构设计
- [docs/deploy.md](docs/deploy.md) — 部署与验收
- [docs/runbook.md](docs/runbook.md) — 故障排查
- [docs/drills.md](docs/drills.md) — 演练清单
- [docs/chaos-methodology.md](docs/chaos-methodology.md) — 混沌演练方法论
