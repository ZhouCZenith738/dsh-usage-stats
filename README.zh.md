# dsh-usage-stats

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，`@deepseek-ai/dsh`）编写的**使用统计插件**：采集每次 LLM 请求的**真实 token**（上游响应 usage），按可编辑价单计费，JSONL 落盘，并提供独立 web 仪表盘与 `/usage` 斜杠命令。

> 功能参考 [cc-switch](https://github.com/farion1231/cc-switch) 的用量统计设计（在响应层采集 usage、token 归一化、价目表计费、仪表盘统计维度）。代码为原创，未搬用其代码。许可与致谢见文末。

## 功能

- **采集零侵入**：挂在 `ctx.llm.stream` 的 `llm/stream` 事件上（`{global:true, prepend:true}`），透传所有分片、在终止分片时收账。真实 token 来自宿协议约定先于终止的 `usage` 分片；两条官方适配器路径（DeepSeek 官方直连 / pi-ai 兼容网关）均已把上游 usage 归一化为 disjoint 4 桶（输入为不含缓存的 miss、缓存命中读、缓存写、输出），故计费直接信任桶值，无需自己从 `prompt_tokens` 还原。
- **计价**：`$DSH_HOME/usage/prices.json` 每百万 token 单价表，可按 `provider`/`model` 配 `inputMiss`/`inputHit`/`output`/`cacheWrite`；模型名带时间戳后缀（`deepseek-v4-flash-0731`）时用 `match:"prefix"` 最长命中。全程整数「纳元」运算（1 纳元 = 1e-9 币），个人账单可复算、无浮点漂移。
- **存储**：明细按 `$DSH_HOME/usage/usage-YYYY-MM.jsonl` 按月追加；读时聚合（个人用量规模无需 SQLite）。
- **展示**：亮色自包含仪表盘 `/usage`（三张总用卡 + 按模型钻取、请求/费用双轴平滑趋势、按模型/按供应商聚合、明细分页、一键打开价单编辑）+ `/usage` 斜杠命令文本摘要。全部接口与宿主同层鉴权（复用会话 cookie）。
- **不侵入**：不改 dsh-llm / 适配器 / 前端 SPA，无构建链；数据全在 `$DSH_HOME/usage/`，删目录即清账。

## 安装（web profile）

```bash
# 1) 把本插件目录放到便于维护的位置，装入 web profile 的 node_modules
cd "$DSH_HOME/profiles/web"
dsh plugin --profile web add "file:</绝对路径>/dsh-usage-stats"
#   若路径含空格（如 Windows 的 "Program Files" 类目录），改用 8.3 短名或手动在
#   package.json 写 dependencies 后执行 pnpm install

# 2) 在 profile 的 cordis.patch.yml 追加挂载块（勿编辑 cordis.yml）
```

```yaml
- insert:
    - id: usage-stats
      name: dsh-usage-stats
      config:
        retentionMonths: 12
```

```bash
# 3) 重启 dsh web（新装依赖需完整重启，热重载不够）
dsh web
```

卸载：移除 `cordis.patch.yml` 中的 insert 块，`dsh plugin --profile web remove dsh-usage-stats`，重启。

## 使用

- 浏览器打开仪表盘：主界面登录后访问 `http://127.0.0.1:3080/usage`（端口随部署配置）。顶部可切换**全部模型 / 单个模型**钻取，日期区间过滤，趋势图为请求数（左轴）+ 费用（右轴）。
- 对话内斜杠命令：`/usage`（无参数，返回本月/今日 token、费用、缓存命中率与仪表盘链接）。
- 明细表下方「编辑价格表」按钮：由服务端用系统默认程序打开价单文件，改完保存即生效（mtime 自动重载，无需重启）。

## 价格表（如何修改定价）

文件：`$DSH_HOME/usage/prices.json`（首启自动从内置默认价单拷贝），**纯手工编辑，保存即生效**。单位：**每百万 token** 的币值。

| 字段 | 含义 |
|---|---|
| `provider` | 路由名（如 `deepseek-official`、`bailian`、`tokenriver`）或 `"*"` 通配 |
| `model` | 模型名，写基础名（`deepseek-v4-flash`）即可被 `prefix` 匹配到 `-0731` 后缀 |
| `match` | `exact` 全等 / `prefix` 前缀最长命中 / `any` 兜底 |
| `inputMiss` / `inputHit` / `output` / `cacheWrite` | 未缓存输入 / 缓存命中读 / 输出 / 缓存写（缺省按 `inputMiss` 折算） |

```jsonc
{ "provider": "bailian", "model": "qwen-max", "match": "prefix",
  "inputMiss": 2.5, "inputHit": 0.3, "output": 7.5, "note": "示例" }
```

命中 `match:"any"` 兜底且单价全 0 的模型，费用按 0 计并出现在仪表盘「未定价」清单。**默认价单为采集时的公开峰值价，请务必以官方定价页或供应商账单核对后覆盖**；历史明细的 `cost` 按记录当时的价单计算，不会回溯。

## 架构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口（Cordis 函数插件：name/inject/apply） |
| `lib/collector.js` | `llm/stream` 流包装，捕获 `usage` 分片 |
| `lib/pricing.js` | 价单加载 / 模糊匹配 / 整数纳元计费 |
| `lib/storage.js` | JSONL 按月追加、区间读取、保留清理 |
| `lib/aggregate.js` | 读时聚合（日 / 模型 / 供应商 / 未定价清单） |
| `lib/http.js` | `/usage` 页面与 `/usage/api/*` 路由（鉴权 + TTL 缓存） |
| `lib/dashboard.js` | 自包含仪表盘 HTML |
| `lib/command.js` | `/usage` 斜杠命令 |
| `lib/home.js` | `$DSH_HOME` 解析（依赖缺失时回落环境变量） |
| `test/smoke.mjs` | 无宿主环境集成冒烟测试 |

## 已知限制

- 失败/中断的请求可能没有 `usage` 分片：只计入请求数、费用按 0（`usage: null`）。
- token 桶来自适配器归一化，不回溯历史会话（安装前产生的用量不在统计内）。
- 唯一运行时依赖 `@deepseek-ai/dsh-home-paths` 当前为预发布版本（`^0.1.2-rc.1`）。
- 仪表盘为独立页面，未嵌入宿主 SPA 侧边栏（宿主前端是预编译产物）。

## 许可

MIT License，见 [LICENSE](./LICENSE)。第三方归属与致谢见 [NOTICE](./NOTICE.md)：

- 运行时依赖 `@deepseek-ai/dsh-home-paths` — MIT — © 2026 DeepSeek
- 功能参考 **cc-switch**（farion1231/cc-switch）— MIT — © 2025 Jason Young — <https://github.com/farion1231/cc-switch>