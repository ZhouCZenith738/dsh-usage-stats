import { dayKey } from "./storage.js";
import { buildOverview } from "./aggregate.js";
import { formatNano } from "./pricing.js";

/**
 * /usage 斜杠命令：会话内直接看本月/今日用量摘要与费用。
 * 实现为无槽位命令（省略 input），handler 返回 {kind:'success', text}。
 */

const today = () => dayKey(Date.now());
const monthStart = () => today().slice(0, 8) + "01";

const fmt = (n) => (n ?? 0).toLocaleString("zh-CN");

export const installCommand = (ctx, { store, pricing, baseUrl, logger }) => {
  const commands = ctx.commands;
  if (!commands) {
    logger?.warn?.("usage-stats: 未发现 commands 服务，跳过 /usage 命令（采集照常）");
    return;
  }
  commands.register({
    name: "usage",
    description: "查看 DSH 用量统计（token 与费用摘要，附仪表盘链接）",
    handler: async (invocation) => {
      if ((invocation?.rawInput ?? "").trim().length > 0) {
        return { kind: "error", text: "用法：/usage（无参数）" };
      }
      try {
        const to = today();
        const from = monthStart();
        const monthRecords = await store.collect(from, to);
        const month = buildOverview(monthRecords, {
          currency: pricing.currency, symbol: pricing.symbol,
        });
        const todayRecords = await store.collect(to, to);
        const day = buildOverview(todayRecords, {
          currency: pricing.currency, symbol: pricing.symbol,
        });
        const lines = [
          `📊 用量 · 本月（${from} ~ ${to}）`,
          `请求 ${fmt(month.requests)} 次（成功 ${fmt(month.okRequests)}）`,
          `输入 ${fmt(month.tokens.inputTokens)} / 输出 ${fmt(month.tokens.outputTokens)} / 缓存读 ${fmt(month.tokens.cacheReadTokens)} / 缓存写 ${fmt(month.tokens.cacheWriteTokens)}`,
          `真实消耗 ${fmt(month.tokens.realTotal ?? 0)} token，缓存命中率 ${((month.tokens.cacheHitRate ?? 0) * 100).toFixed(1)}%`,
          `费用 ${formatNano(month.cost.total, month.cost.symbol)}（按价单 ${month.cost.currency}/百万token 折算）`,
          `今日：请求 ${fmt(day.requests)}，费用 ${formatNano(day.cost.total, day.cost.symbol)}`,
          month.unpriced.length > 0
            ? `⚠️ 未定价模型 ${month.unpriced.map((m) => `${m.model}×${m.count}`).join("、")}（请在 $DSH_HOME/usage/prices.json 补价格）`
            : "",
          `仪表盘：${baseUrl}/usage（同一浏览器已登录 DSH 即可打开）`,
        ].filter(Boolean);
        return { kind: "success", text: lines.join("\n") };
      } catch (err) {
        logger?.warn?.(`usage-stats: /usage 命令失败：${err.message ?? err}`);
        return { kind: "error", text: `用量统计读取失败：${err.message ?? err}` };
      }
    },
  });
};