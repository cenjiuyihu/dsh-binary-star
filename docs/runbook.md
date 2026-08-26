# 运行手册（Runbook）

## 故障处置速查

| 现象 | 自动处置 | 人工动作 |
|---|---|---|
| 主星崩溃/被杀 | 快速路径：重启+探针（~30s） | 无 |
| 启动即崩（配置坏） | 阶梯：校验→回滚账目→快照还原 | 无 |
| 进程挂死（心跳停） | D3：强杀+重启 | 无 |
| 会话层坏（进程活但对话全废） | L3 自检 → degraded → 处置 | 无 |
| 阶梯用尽 | 顶班等待：授权文件或超时自动接管 | `dsh-binary takeover --now` 或等超时 |
| 顶班中 | 代班实例（卫星副本）就绪；开修复智能体会话，读 `seed/latest.txt` 续接 | 修复主星后 `dsh-binary takeover --undo` |
| 受控自重启失败 | 阶梯回滚；3 次后标记 `.failed` 停自动重试 | 人工处置（见下） |
| 监督者被误杀 | watchdog/桌面壳自动拉起（若已部署） | 无守护时 `dsh-binary start` 重新拉起 |
| 会话卡死（发消息即 400） | — | `dsh-binary session-repair`（见下） |

## 控制文件（`<stateDir>/control/`）

| 文件 | 作用 |
|---|---|
| `shutdown` | 监督者受控关闭（停主星→释放锁→退出） |
| `restart-request.json` | 受控自重启验证请求（含 journalEntryId） |
| `authorize-takeover.json` | 顶班人工授权 |
| `handback-request.json` | 交回请求 |
| `halt` | 暂停自动修复（删文件恢复） |

## 双星全挂：人工最后防线（无 LLM 依赖）

1. **清点现场**：`node src/cli.js status`；读 `<stateDir>/logs/supervisor.log` 与 `logs/repair/`
2. **杀残留进程**：`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*bin.js*' }`（除真实主星外全部 taskkill）
3. **shell 阶梯**（每步用 `node <dsh>/lib/bin.js web --dump-config` 退出码验证）：
   - 重启监督者 → 看心跳
   - 有 open 账目 → `dsh-binary journal rollback <id>`
   - 从最近快照还原（`snapshots/` 下带 meta.json 的最新目录）
   - 重装 dsh 版本（记录 last-known-good）+ 按需重跑部署方 UI 补丁
4. **验证恢复**：status 显示主星 RUNNING、心跳新鲜；浏览器可打开 :3080
5. **若曾顶班**：`dsh-binary takeover --undo` 交回

## 注意事项

- 自我修改前必须记账（`journal open`）；需要重启生效的加 `--restart-required` 并写 restart-request
- 修复只动保护范围；sessions/storages/credentials/用户工作区永不触碰
- 监督者单实例；锁被占用且确认无监督者时删 `locks/supervisor.lock`
- 卫星 profile 的 cordis.patch.yml 是"副本"根基，任何人不得修改

## Agent 操作护栏（"医者不能自医"，2026-08-26 两次事故教训）

运行在 dsh 会话内的 agent **禁止**执行以下操作——它们会破坏 agent 自己运行所需的宿主环境：

| 禁止操作 | 后果（已真实发生） | 正确做法 |
|---|---|---|
| `taskkill` / 杀监督者或主星进程树 | 监督者被杀 → 双星失明，无人兜底 | 用 `dsh-binary stop` 受控关闭；或由外部进程操作 |
| 写 `control/shutdown` | agent 自己运行在主星里 → 自杀宿主，全灭 | 重启只能由外部（独立终端/桌面壳）发起 |
| 重写 `sessions/` 下任何会话文件 | 单帧 zstd 重写毒化会话存储 → 主星无法启动 | 用 `dsh-binary session-repair`（多帧格式）且由外部执行 |
| 在会话内"自检并修复"自己的宿主 | 修复动作触发重启即中断自身 | 只诊断、不执行；执行交给外部 |

**会话文件格式契约**：dsh 会话日志 = 每条记录一个独立的 zstd 帧（每帧一行 JSON + `\n`，带 checksum 标志）。
任何工具重写会话文件都必须逐行压缩成多帧，并自校验"帧数=行数、首帧恰好一行 header"；
否则 dsh-workspace 启动时校验失败（`corrupt Zstandard session log: first frame is not exactly one header line`），主星无法启动。

## 会话卡死修复 SOP（API 400 孤儿 tool_calls）

现象：某个会话"发任何消息都立刻失败"，日志出现
`An assistant message with 'tool_calls' must be followed by tool messages`（INVALID_REQUEST 400）。

原因：模型流被中断（主星重启/网络）时，流式 chunks 已持久化但 tool/call+result 未写入，
组装出的历史含"孤儿 tool_calls"；dsh 官方 repair 不覆盖 chunks 组装层。

处置（**全部由外部执行**，agent 只诊断）：
1. 诊断：`dsh-binary session-repair <会话目录> --dry-run`（列出 error turn）
2. 修复：`dsh-binary session-repair <会话目录> --all-error-turns`（自动备份 + 多帧重写 + 自校验）
3. 外部重启主星清缓存（受控重启或重启监督者）
4. 验证：会话内发消息应恢复正常

## 监督者守护（防单点）

监督者是双星的大脑，它死了顶班也无法执行。纯 CLI 模式没有自带守护：
- 推荐：`node scripts/supervisor-watchdog.js`（独立外部进程，监督者崩溃后自动重启，带日志与重启上限）
- 或：Windows 任务计划开机自启 `dsh-binary start`（失败重启策略）
- 桌面壳已内置看门狗（仅覆盖壳自己拉起的监督者）

## 事故复盘：2026-08-26 两次崩溃

**第一次（会话卡死 → 监督者误杀 → 野生实例抢端口）**
1. godot 会话工具调用超时 + 孤儿 tool_calls → 会话 400 卡死
2. 会话内自修复 agent 执行 `taskkill` 误杀监督者 → 双星失明
3. E 盘另一 dsh 实例（TRAE 部署）抢占 :3080 → 主星 EADDRINUSE（错误被 cordis 包装成
   "plugin tree failed to load: include"，误导诊断）→ 受控重启 4 连败 → 阶梯 exhausted

**第二次（会话修复单帧重写 → 毒化存储 → agent 自伤）**
1. 修复工具把会话重写为**单个 zstd 帧**（违反"每行一帧"契约）→ 主星启动即崩
2. agent 写 `control/shutdown` 关闭监督者 → **杀死自己的宿主** → 全灭

**改进落地**：野生实例防护（`clearForeignPortOwner`，重启主星前清理端口占用）、
session-repair 多帧重写 + 自校验、ladder 顶班语义澄清、本护栏文档、supervisor-watchdog。
