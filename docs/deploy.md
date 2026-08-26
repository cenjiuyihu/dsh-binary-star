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
| `picker` | 目录选择器：`browse`（页面内浏览，Win32 双星场景推荐）或留空（dsh 原生行为） |
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

## 已知问题：Win32 下目录选择器不可见

经监督者启动的主星在 Windows 上点击"选择工作区"时，dsh 默认使用**原生文件夹对话框**
（`IFileOpenDialog`，`dsh-host-directory-picker-auto` 在 win32 + loopback 下解析为
native 后端）。但监督者以无窗口方式（`windowsHide`）拉起主星，对话框无法显示到
交互桌面（Windows 前台激活限制）→ 25s 超时 → 按钮看起来"无响应"（输入框 readonly
是 dsh 设计：未选工作区不能对话）。

**解决**：`config` 设置 `"picker": "browse"`（默认配置已启用）——监督者启动主星时注入
`SSH_CONNECTION` 标志，让 dsh 的 auto 决策（loopback + SSH → browse）改用**页面内
目录浏览**。该开关只影响监督者拉起的实例；手动 `dsh web` 仍使用原生对话框。
