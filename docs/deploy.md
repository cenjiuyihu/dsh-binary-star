# 部署指南

> 目标：把宿主插件挂进真实 web profile，让主星有心跳/自检；监督者负责自愈执行。

## 前置

- Node.js >= 20（含 `node:zlib` 的 zstd 支持）
- 全局安装 dsh：`npm install -g @deepseek-ai/dsh`（适配 0.1.1-rc.2）
- 确认 dsh 可运行：`dsh web` 能启动

## 配置

`config.default.json`（占位符：`$HOME` 用户主目录 / `$CWD` 运行目录 / `$NPM_ROOT` npm 全局根）：

| 字段 | 说明 |
|---|---|
| `dshHome` | DSH 主目录（默认 `$HOME/.dsh`） |
| `dshPkg` | dsh 包位置（默认 `$NPM_ROOT` 自动解析） |
| `stateDir` | 双星状态目录 |
| `primaryProfile` / `primaryWorkdir` / `primaryPort` | 主星 profile / 工作目录 / 端口 |
| `snapshot.scope` | 保护范围（快照/还原的对象） |

## 部署宿主插件（自动备份 + 验证，可回滚）

```bash
node scripts/deploy-live.js
```

步骤：预检组合树 → 备份 `cordis.patch.yml` 到 `backup/pre-live-<ts>/` → 创建 node_modules junction → 追加组合行 → `--dump-config` 验证。

- 生效方式：配置 HMR 可能实时生效（无需重启）；若心跳未出现需重启主星一次
- 回滚：`copy backup\pre-live-<ts>\cordis.patch.yml 到 profiles/web/cordis.patch.yml` + `rmdir profiles/web/node_modules/dsh-binary-star-host`

## 验收

```bash
node scripts/verify-live.js
```

只读检查：组合树可解析且含新行 / junction / patch 行 / 心跳存在+健康+新鲜 / 状态文件。监督者未启动时 token=none 与 state.json 缺失为预期。

## 升级 dsh 版本（兼容流程）

```bash
# 1. 暂停自动修复 + 打升级前快照
New-Item -ItemType File control/halt
node src/cli.js snapshot baseline-pre-upgrade

# 2. 升级 npm 全局包
npm install -g @deepseek-ai/dsh@<新版本>

# 3. 客户端定制若被覆盖，重跑 ui-patch（本仓库不携带；部署方自己的脚本）
#    anchor 失配 = 新版本改了 bundle 结构，需按新结构更新补丁

# 4. 冒烟：组合树可解析
node <dsh>/lib/bin.js --profile web --dump-config

# 5. 受控重启验证（写 restart-request.json，监督者执行重启+探针）
node src/cli.js journal open --desc "dsh 升级验证"
# 写 control/restart-request.json {journalEntryId, desc} → 监督者受控重启 → 探针
node src/cli.js journal commit <id>

# 6. 验收
node scripts/verify-live.js
```

> 注意：受控重启会短暂中断当前对话（秒级~1 分钟）；若端口未及时释放，阶梯会自动重试，属预期行为。

## 卫星副本 profile

顶班需要 `profiles/satellite`（web bundles + 自有最小 patch，只挂宿主插件）。
node_modules 依赖可复用主星 profile 的依赖树（junction）：

```
profiles/satellite/
  package.json       bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]
  cordis.yml         []
  cordis.patch.yml   - insert: binary-star-host
  node_modules/@deepseek-ai → junction 到主星 profile 的 node_modules/@deepseek-ai
```

> 卫星 profile 的 patch **永不自我修改**——这是"配置坏透时还有环境能启动"的保证。

## 启动方式

| 方式 | 命令 |
|---|---|
| 命令行（前台常驻） | `node src/cli.js start`（停止：另开窗口 `node src/cli.js stop` 或 Ctrl+C） |
| 桌面壳托管 | 壳检测到 :3080 已占用不会重复拉起；由壳/任务计划管理监督者进程 |

## 状态

```bash
node src/cli.js status   # 两星状态/心跳/账本/快照/上次修复
```
