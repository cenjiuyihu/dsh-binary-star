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
| 监督者被误杀 | — | `dsh-binary start` 重新拉起 |

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
