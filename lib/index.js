import { installCollector } from "./collector.js";
import { installHttp } from "./http.js";
import { installCommand } from "./command.js";
import { dshHomePath } from "./home.js";
import { PricingTable, ensurePricesFile, rateRecord } from "./pricing.js";
import { UsageStore } from "./storage.js";

/**
 * dsh-usage-stats 插件入口。
 *
 * 函数插件形态（与 webhook-github 同款）：导出 { name, inject, apply }，
 * loader 经 module.default ?? module 解包后交给 cordis registry。
 *
 * 功能装配：
 *   1. 采集    → collector.js 在 llm/stream 上包装观测，finish 时交给 sink；
 *   2. 计价    → sink 内 rateRecord(pricing, rec)（可编辑价单 + 纳元整数运算）；
 *   3. 落盘    → UsageStore 追加 $DSH_HOME/usage/usage-YYYY-MM.jsonl；
 *   4. 展示    → http.js 挂 /usage 仪表盘 + 4 个 JSON API；command.js 挂 /usage 命令。
 *
 * config（patch 层可配）：
 *   - retentionMonths: 明细保留月数，默认 12；
 *   - pricesPath:     覆盖价单文件路径（默认 $DSH_HOME/usage/prices.json）；
 *   - baseUrl:        仪表盘对外地址（默认 http://127.0.0.1:3080，端口不同时覆盖）。
 */

export const name = "usage-stats";

/** 依赖的服务：web profile 固定提供这三者（SPA 本身依赖它们） */
export const inject = ["webServer", "connection", "commands"];

function apply(ctx, config) {
  const cfg = config ?? {};
  const logger = ctx.logger;
  const retentionMonths = Number(cfg.retentionMonths ?? 12);
  const baseUrl = String(cfg.baseUrl ?? "http://127.0.0.1:3080");
  const sinkLogger = { info: (...a) => logger.info(...a), warn: (...a) => logger.warn(...a) };

  let pricing;
  const start = async () => {
    const home = await dshHomePath();
    const pricesFile = await ensurePricesFile(home, cfg.pricesPath);
    pricing = await PricingTable.load(pricesFile, logger);
    const store = new UsageStore(home, sinkLogger);
    // 启动即清一次过期分片（与默认保留期一致）
    void store.prune(retentionMonths);

    // 1. 采集：每 finish 一条 → 计价 → 落盘（异步链，_不影响_ llm 流本身）
    installCollector(ctx, (rec) => {
      try {
        rateRecord(pricing, rec);
      } catch (err) {
        logger.warn(`usage-stats: 计价失败（仍会落盘原始记录）：${err.message ?? err}`);
      }
      void store.append(rec).catch((err) => {
        logger.warn(`usage-stats: 记录落盘失败：${err.message ?? err}`);
      });
    }, sinkLogger);

    // 2. 展示：仪表盘 + API
    installHttp(ctx, { store, pricing, logger });

    // 3. /usage 命令
    installCommand(ctx, { store, pricing, baseUrl, logger });

    logger.info("usage-stats: 用量统计已启用（价单 %s，保留 %d 个月，仪表盘 %s/usage）", pricesFile, retentionMonths, baseUrl);
  };

  void start().catch((err) => {
    // 装配失败不应让 dsh 起不来：降级为"采集不装"，仅记录
    logger.error(`usage-stats: 初始化失败：${err?.stack ?? err}`);
  });
}

export { apply };