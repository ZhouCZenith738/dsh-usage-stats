import { dayKey } from "./storage.js";

/**
 * 读时聚合。对一批已按 (from, to) 过滤的记录做多维度折叠：
 * 汇总卡（请求数/tokens/费用）、按日序列、按模型、按供应商、未定价清单。
 * 全部整数（纳元/token）累加，无浮点漂移。
 */

const addTokens = (a, b) => {
  a.inputTokens += b?.inputTokens ?? 0;
  a.outputTokens += b?.outputTokens ?? 0;
  a.cacheReadTokens += b?.cacheReadTokens ?? 0;
  a.cacheWriteTokens += b?.cacheWriteTokens ?? 0;
};

const addCost = (a, b) => {
  if (!b) return; // 未定价/失败请求不计费
  a.total += b.total ?? 0;
  a.input += b.input ?? 0;
  a.output += b.output ?? 0;
  a.cache += (b.cacheRead ?? 0) + (b.cacheWrite ?? 0);
};

const costZero = () => ({ total: 0, input: 0, output: 0, cache: 0 });

/**
 * @param {object[]} records 区间内采集记录（已过滤 t 区间）
 * @param {object} opts { currency, symbol }
 */
export function buildOverview(records, { currency, symbol }) {
  let requests = 0, okRequests = 0, failed = 0;
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const cost = costZero();
  const byDayMap = new Map();   // dayKey -> {day, requests, okRequests, tokens, cost}
  const byModelMap = new Map(); // model -> {model, requests, tokens, cost, unpriced}
  const byProviderMap = new Map();
  const unpricedMap = new Map(); // model -> count

  for (const r of records) {
    requests += 1;
    if (r.ok) okRequests += 1; else failed += 1;
    if (r.usage) addTokens(tokens, r.usage);
    if (r.cost) addCost(cost, r.cost);

    const dk = dayKey(r.t);
    let d = byDayMap.get(dk);
    if (!d) { d = { day: dk, requests: 0, okRequests: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: costZero() }; byDayMap.set(dk, d); }
    d.requests += 1;
    if (r.ok) d.okRequests += 1;
    if (r.usage) addTokens(d.tokens, r.usage);
    if (r.cost) addCost(d.cost, r.cost);

    const mk = r.model ?? "(unknown)";
    let m = byModelMap.get(mk);
    if (!m) { m = { model: mk, requests: 0, okRequests: 0, unpriced: false, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: costZero() }; byModelMap.set(mk, m); }
    m.requests += 1;
    if (r.ok) m.okRequests += 1;
    if (r.usage) addTokens(m.tokens, r.usage);
    if (r.cost) addCost(m.cost, r.cost);
    if (r.unpriced) { m.unpriced = true; unpricedMap.set(mk, (unpricedMap.get(mk) ?? 0) + 1); }

    const pk = r.provider ?? "(unknown)";
    let p = byProviderMap.get(pk);
    if (!p) { p = { provider: pk, requests: 0, okRequests: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: costZero() }; byProviderMap.set(pk, p); }
    p.requests += 1;
    if (r.ok) p.okRequests += 1;
    if (r.usage) addTokens(p.tokens, r.usage);
    if (r.cost) addCost(p.cost, r.cost);
  }

  const byDay = [...byDayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const byModel = [...byModelMap.values()].sort((a, b) => b.cost.total - a.cost.total || b.requests - a.requests);
  const byProvider = [...byProviderMap.values()].sort((a, b) => b.cost.total - a.cost.total || b.requests - a.requests);
  const unpriced = [...unpricedMap.entries()].map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);

  // 派生指标（模仿 cc-switch 口径）：
  //   真实消耗 Tokens = input(未缓存) + output + cacheRead(命中) + cacheWrite(写) —— 全部 4 桶
  //   缓存命中率    = cacheRead / (input + cacheRead + cacheWrite) —— 分母即计费的输入侧
  tokens.realTotal = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  const billedInput = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  tokens.cacheHitRate = billedInput > 0 ? tokens.cacheReadTokens / billedInput : 0;

  return {
    requests,
    okRequests,
    failed,
    tokens,
    cost: { ...cost, currency, symbol },
    byDay,
    byModel,
    byProvider,
    unpriced,
  };
}

/**
 * 明细分页：倒序（新在前），游标 afterId 为上一页最后一个 id。
 */
export function paginate(records, { limit = 50, afterId } = {}) {
  const sorted = [...records].sort((a, b) => b.t - a.t);
  const startIdx = afterId ? sorted.findIndex((r) => r.id === afterId) + 1 : 0;
  const rows = startIdx === 0 && !afterId ? sorted.slice(0, limit)
    : startIdx <= 0 ? [] : sorted.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < sorted.length;
  return { rows, hasMore, nextAfterId: rows.length ? rows[rows.length - 1].id : null };
}

/** 过滤（model/provider/purpose 均为可选的精确匹配） */
export function filterRecords(records, { model, provider, purpose } = {}) {
  return records.filter((r) => {
    if (model && r.model !== model) return false;
    if (provider && r.provider !== provider) return false;
    if (purpose && (r.purpose ?? "conversation") !== purpose) return false;
    return true;
  });
}