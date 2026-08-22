# 沙箱演练说明（drills）

本项目自带 70+ 项演练：**故意把系统搞炸，验证它能自己修好**。演练在隔离沙箱运行，不碰真实部署。

## 演练清单

| 脚本 | 覆盖 |
|---|---|
| `drill-supervisor.js` | A: 杀主星→快速路径重启；B: 改坏配置+open 账目→崩溃→阶梯回滚（16 项） |
| `drill-loop.js` | 真实 tick 循环下杀主星→10s 内 D1→快速路径恢复（4 项） |
| `drill-p2.js` | 卫星心跳、L3 自检 degraded 上报、`--dump-config` 冒烟（10 项） |
| `drill-p2b.js` | 账本 CLI 回路、受控自重启成功/失败回滚（15 项） |
| `drill-p3.js` | 顶班全流程：阶梯用尽→授权→卫星副本接管→交回→会话归档（12 项） |
| `drill-chaos.js` | 挂死 D3、boot loop、代班被杀自愈、修复报告（13 项） |
| `drill-shutdown.js` | 受控关闭、孤儿检测（7 项） |
| `drill-handover.js` | 监督者启动时接管已在运行的主星（6 项） |
| `diag-*.js` | 诊断工具（spawn 行为、会话 zstd 结构） |

## 沙箱环境搭建

演练需要两个沙箱件（均与真实部署隔离）：

1. **沙箱 profile**：`<dshHome>/profiles/sbx/`
   ```
   cordis.yml         []
   cordis.patch.yml   - insert: binary-star-host
   package.json       { "dsh": { "profile": { "bundles": [] } } }
   node_modules/dsh-binary-star-host → junction 到本仓库 plugin/
   ```
2. **沙箱状态目录**：演练脚本顶部常量指向（如 `<dshHome>/binary-star-sbx/`），
   快照 scope 为空（保证演练永不触碰真实 profile 文件）

> 演练脚本是**自足工具**：顶部常量即环境配置（`PROJECT`/`SANDBOX_CONFIG`/`STATE`/`SBX_PATCH`/`CANONICAL_PATCH` 等），
> 按你的环境修改后即可运行。`CANONICAL_PATCH` 会在起跑时强制恢复沙箱 profile 的规范内容（自愈式预检）。

## 运行

```bash
node scripts/drill-supervisor.js    # 输出 PASS/FAIL 汇总，全 PASS 即通过
node scripts/drill-loop.js
# ...其余同理
```

> 注意：演练会启动/杀死沙箱进程并短暂占用测试端口（3180/3181），不要在真实服务运行期间与演练并行。
