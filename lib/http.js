import { buildOverview, paginate, filterRecords } from "./aggregate.js";
import { renderDashboardHtml } from "./dashboard.js";
import { dayKey } from "./storage.js";

/**
 * HTTP 层：在 dsh-host-webserver 上挂一个 prefix 路由 /usage。
 *
 * - /usage 与 /usage/ → 内嵌仪表盘 HTML；
 * - /usage/api/overview|requests|models|summary → JSON 接口；
 * - 每个请求先过 ctx.connection.requestRejection(req)（复用 SPA 的会话 cookie 鉴权）。
 *
 * 不进入 dsh-web-app 的 SPA（其前端是预编译产物、client 插件构建链未随全局分发），
 * 页面是零构建的 self-contained HTML，浏览器 fetch 同源 API 天然带 cookie。
 */

const DASHBOARD_HTML = renderDashboardHtml();
const CACHE_TTL_MS = 30_000; // 聚合结果短缓存：避免每次开页都扫盘

const HEAD = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const urlOf = (req) => new URL(req.url ?? "/", "http://localhost");

const sendJson = (res, obj) => {
  res.writeHead(200, HEAD);
  res.end(JSON.stringify(obj));
};

const sendHtml = (res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
};

const sendCode = (res, code, text) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text ?? "");
};

const todayKey = () => dayKey(Date.now());
const monthStartKey = () => todayKey().slice(0, 8) + "01";

/** 取查询参数或默认值 */
const param = (u, key, def) => {
  const v = u.searchParams.get(key);
  return v && v.trim() ? v.trim() : def;
};

const numParam = (u, key, def, max) => {
  const v = Number.parseInt(param(u, key, ""), 10);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(v, max);
};

/**
 * 安装 /usage 路由。
 * @param {object} ctx
 * @param {{store: UsageStore, pricing: PricingTable, logger: object}} deps
 * @returns {() => void} disposer（未装上 webServer 时返回空操作）
 */
export const installHttp = (ctx, { store, pricing, logger }) => {
  const ws = ctx.webServer;
  if (!ws || !ctx.connection) {
    logger?.warn?.("usage-stats: 未发现 webServer/connection 服务，跳过 /usage 页面（采集照常）");
    return () => {};
  }

  const guard = (req, res) => {
    const rejection = ctx.connection.requestRejection(req); // 403 | 401 | undefined
    if (rejection !== void 0) {
      sendCode(res, rejection, rejection === 401
        ? "unauthorized — 请先在同一浏览器打开 DSH 主界面登录后再访问 /usage"
        : "forbidden");
      return true;
    }
    return false;
  };

  // 聚合结果 TTL 缓存（键含模型维度：三卡可按"全部模型/单个模型"切换查看）
  const ovCache = new Map();
  const getOverview = async (from, to, force = false, model = null) => {
    const key = `${from}|${to}|${model ?? "*"}`;
    if (!force) {
      const hit = ovCache.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
    }
    let records = await store.collect(from, to);
    if (model) records = filterRecords(records, { model });
    const table = pricing;
    const value = buildOverview(records, { currency: table.currency, symbol: table.symbol });
    ovCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    // 防缓存无限膨胀：超过 200 项清空
    if (ovCache.size > 200) ovCache.clear();
    return value;
  };

  const overviewHandler = async (u, res) => {
    const from = param(u, "from", monthStartKey());
    const to = param(u, "to", todayKey());
    const model = param(u, "model", null);
    sendJson(res, await getOverview(from, to, false, model));
  };

  const requestsHandler = async (u, res) => {
    const from = param(u, "from", monthStartKey());
    const to = param(u, "to", todayKey());
    const limit = numParam(u, "limit", 50, 200);
    const afterId = param(u, "afterId", null);
    const records = filterRecords(await store.collect(from, to), {
      model: param(u, "model", null),
      provider: param(u, "provider", null),
      purpose: param(u, "purpose", null),
    });
    sendJson(res, paginate(records, { limit, afterId }));
  };

  const modelsHandler = async (u, res) => {
    // 命中自查：默认回溯 90 天出现的 (provider, model) 各自的匹配结果与定价状态
    const to = todayKey();
    const from = param(u, "from", dayKey(Date.now() - 90 * 86400_000));
    const seen = new Map(); // 组合键 -> {provider, model, count}
    for await (const rec of store.iterate(from, to)) {
      const key = JSON.stringify([rec.provider ?? "?", rec.model ?? "?"]);
      let e = seen.get(key);
      if (!e) { e = { provider: rec.provider, model: rec.model, count: 0 }; seen.set(key, e); }
      e.count += 1;
    }
    const rows = [...seen.values()]
      .map((e) => {
        const hit = pricing.findRate(e.provider, e.model);
        return {
          provider: e.provider,
          model: e.model,
          count: e.count,
          matchedRule: hit ? hit.rate.model : null,
          match: hit ? hit.match : null,
          priced: hit ? !(hit.rate.inputMiss === 0 && hit.rate.inputHit === 0 && hit.rate.output === 0) : false,
        };
      })
      .sort((a, b) => b.count - a.count);
    sendJson(res, { currency: pricing.currency, symbol: pricing.symbol, rows });
  };

  const openPricesHandler = async (u, res) => {
    // 浏览器不能直接开本地 file://，由服务端用系统默认关联程序打开价单文件
    const file = pricing.file; // PricingTable 实际加载的价单路径（兼容 config.pricesPath 覆盖）
    const { execFile } = await import("node:child_process");
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", file], { windowsHide: true });
    } else {
      execFile("xdg-open", [file]);
    }
    sendJson(res, { ok: true, file });
  };

  const summaryHandler = async (u, res) => {
    const from = param(u, "from", monthStartKey());
    const to = param(u, "to", todayKey());
    const model = param(u, "model", null);
    const ov = await getOverview(from, to, true, model); // 命令场景要实时，绕过缓存
    sendJson(res, {
      currency: ov.cost.currency,
      symbol: ov.cost.symbol,
      requests: ov.requests,
      okRequests: ov.okRequests,
      tokens: ov.tokens,
      costTotal: ov.cost.total,
      unpriced: ov.unpriced,
      byDay: ov.byDay,
      byProvider: ov.byProvider,
      byModel: ov.byModel,
    });
  };

  const route = {
    kind: "prefix",
    path: "/usage",
    handler: async (req, res) => {
      if (guard(req, res)) return;
      const u = urlOf(req);
      const p = u.pathname;
      if (p === "/usage" || p === "/usage/") return sendHtml(res);
      if (p === "/usage/api/overview") return overviewHandler(u, res);
      if (p === "/usage/api/requests") return requestsHandler(u, res);
      if (p === "/usage/api/models") return modelsHandler(u, res);
      if (p === "/usage/api/summary") return summaryHandler(u, res);
      if (p === "/usage/api/open-prices") return openPricesHandler(u, res);
      sendCode(res, 404, "not found");
    },
  };

  // ctx.effect 包装：patchReload 热替换时自动注销路由，避免 duplicate route 报错
  return ctx.effect(() => ws.register(route), "usage-stats: /usage");
};