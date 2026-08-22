# dsh-binary-star 双星系统

让 DeepSeek Harness (DSH) 智能体拥有"把自己搞坏后能自己修好"的能力：
**主星干活，卫星（副本 profile）待命，监督者（纯 Node、无 LLM）负责监视、修复、顶班。**

> 本项目由 AI 辅助开发。适用 Windows；dsh 版本 0.1.0-rc.7。

## 特性

- **三线检测**：L1 心跳（进程层）/ L3 自检（配置被改坏未崩溃即上报 degraded）/ 组合树冒烟（`--dump-config`）
- **变更账本**：自我修改先记账（`journal open/commit/rollback`），崩溃 = 一笔 open 账目 = 修复头号嫌疑
- **修复阶梯**（0-6，每步验证、成功即停）：重启 → 校验 → 回滚账目 → 快照还原 → 重装 → 顶班；每次执行写结构化修复报告
- **受控自重启验证**：需重启生效的修改 → 受控重启 → 探针验证 → 失败自动回滚（根治"装完重启后全废"）
- **代班接管（failover）**：阶梯用尽 → 授权/超时 → 卫星副本 profile 顶班（GUI + 修复智能体 + 会话种子续接）→ 交回时会话归档
- **70+ 项沙箱演练**（`scripts/drill-*.js`）：故意搞炸系统来证明它能修

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

前置：Node.js >= 20、全局安装 `@deepseek-ai/dsh`（本项目适配 0.1.0-rc.7）。

```bash
# 1. 部署宿主插件到真实 web profile（自动备份 + 验证，可回滚）
node scripts/deploy-live.js

# 2. 验收（只读 11 项检查）
node scripts/verify-live.js

# 3. 启动监督者（前台常驻；或用你的桌面壳/任务计划托管）
node src/cli.js start

# 4. 状态
node src/cli.js status
```

路径配置：`config.default.json` 支持占位符——`$HOME`（用户主目录）、`$CWD`（运行目录）、`$NPM_ROOT`（npm 全局根，自动解析）；也可用环境变量覆盖：`DSH_BINARY_CONFIG`、`DSH_BINARY_STATE`、`DSH_BINARY_DSH_HOME`。

## 命令

```bash
dsh-binary start | stop | status | snapshot <tag> | repair --now | halt
dsh-binary journal open|commit|rollback|list
dsh-binary takeover --now | --undo
```

## 自我修改的正确姿势

```bash
dsh-binary journal open --desc "安装 xx 插件" --scope profiles/web/cordis.patch.yml,profiles/web/package.json --restart-required
# ...修改...
dsh-binary journal commit J-000001
# 需重启生效时写 control/restart-request.json → 监督者受控重启+探针验证+失败自动回滚
```

## 文档

- `docs/architecture.md` —— 角色、机制、状态机详解
- `docs/deploy.md` —— 部署与验收步骤
- `docs/runbook.md` —— 故障速查与人工最后防线
- `docs/drills.md` —— 沙箱演练说明（含环境配置）

## 许可证

MIT（见 LICENSE）。依赖 dsh 的版权见 NOTICE.md。

## 致谢与说明

- 本项目的核心思想来自"副本 + 账本 + 分级修复"：修复永远优先精准回滚（账本定位），副本/快照是兜底。
- 演练脚本为环境特定自足工具，运行前需按环境修改顶部常量（见 docs/drills.md）。
