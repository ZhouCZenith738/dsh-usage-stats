# Third-Party Notices

本插件（`dsh-usage-stats`）代码为原创，以 MIT 许可发布（见 [LICENSE](./LICENSE)）。
以下第三方以其自身许可被使用或作为功能参考，归属声明如下：

## 运行时依赖

- **@deepseek-ai/dsh-home-paths** — MIT License — Copyright (c) 2026 DeepSeek
  - 来源：<https://github.com/deepseek-ai/deepseek-harness>（`packages/util/home-paths`）
  - 用途：解析 `$DSH_HOME` 路径。注意：当前声明为预发布版本 `^0.1.2-rc.1`。

## 宿主生态（不随本插件分发，仅存在于 dsh 运行环境）

- `@deepseek-ai/dsh`、`@deepseek-ai/cordis` 及 dsh-* 系列包 — 均为 MIT License（Copyright DeepSeek / Shigma 系）。

## 功能参考

- **cc-switch**（`farion1231/cc-switch`）— MIT License — Copyright (c) 2025 Jason Young
  - 来源：<https://github.com/farion1231/cc-switch>
  - 本插件的用量统计功能参考其设计（在响应层采集 usage、token 归一化、价目表计费、仪表盘统计维度）；**代码为原创，未搬用其代码**。

各许可全文请见各上游仓库 LICENSE 文件。