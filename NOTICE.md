# NOTICE —— 依赖与版权声明

## 本项目依赖

- **@deepseek-ai/dsh**（DeepSeek Harness）
  - 本项目是 dsh 的"周边自愈系统"，深度依赖其机制：profile 组合（`$DSH_HOME/profiles/*`）、`bin.js` 启动器（`--profile`/`--port`/`--patch`/`--dump-config`）、Cordis 插件体系、会话存储格式。
  - 版权归其原作者所有。请遵循 dsh 自身许可证的条款（npm 包内 LICENSE 为准）。
  - 本项目适配版本：`0.1.0-rc.8`（已验证 0.1.0-rc.7 → rc.8 升级；接口可能随版本变化，使用时请核对）。

- **Node.js**（>= 20，含 `node:zlib` 的 zstd 支持）

## 关于 ui-patch（重要）

部署方可能使用本地脚本直接修改 dsh 的客户端 bundle（本项目配置中的 `uiPatch` 字段）。
这是**部署方自己的定制**，不属于本项目的分发内容：
- 本仓库不携带任何修改 dsh 客户端 bundle 的代码或补丁文件；
- 若你在自己的部署中使用此类定制，请自行标注"修改了哪些文件、基于哪个 dsh 版本"。

## 关于演练脚本

`scripts/drill-*.js` 与 `scripts/diag-*.js` 是环境特定的自足演练工具：
为不暴露作者机器的路径，脚本内**不含任何硬编码绝对路径**——所有路径均在运行时推导
（`os.homedir()` 用户主目录、`__dirname` 项目根、沙箱演练布局 `../.binary-star`），
并可用环境变量覆盖（如 `DSH_BIN`、`DSH_SBX_STATE`、`DSH_SBX_PATCH`）。
如果你复制到自己的环境运行，请核对推导出的路径是否与你的沙箱布局一致
（详见 `docs/drills.md`）。
