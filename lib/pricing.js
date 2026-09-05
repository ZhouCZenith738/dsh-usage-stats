import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 计价模块。
 *
 * 模仿 cc-switch 的做法：
 * - 价单 = 每百万 token 单价表（本地 JSON，用户可编辑，首启从内置默认价单拷贝）；
 * - 模型名带时间戳后缀（deepseek-v4-flash-0731），按 prefix 最长命中模糊匹配；
 * - 全程整数"纳元"运算（1 纳元 = 1e-9 币），避免浮点累积误差，个人账单可复算。
 *
 * 换算（关键，勿改错量级）：
 *   价格 price 的单位是"币 / 1e6 token"，故每 token 的币值 = price / 1e6；
 *   换成纳元（1e-9 币），每 token = price / 1e6 × 1e9 = price × 1e3 纳元。
 *   单价 ≤3 位小数时（LLM 计费实际如此）该值为整数 → 后面全程整数累加。
 *
 * 计费口径（已由 dsh-llm 适配器归一化为 disjoint 4 桶，直接信任桶值）：
 *    billable = inputTokens(未缓存) + cacheReadTokens(缓存命中) + cacheWriteTokens(缓存写)
 *    cost = input×inputMiss + cacheRead×inputHit + cacheWrite×cacheWrite(无写价按 miss) + output×output
 */

const NANO_SCALE = 1e9; // 1 币 = 1e9 纳元
const NANO_PER_CURRENCY_PER_TOK = 1e3; // price(币/1e6 token) → 纳元/token 的系数

/** 内置默认价单（打成本包自带文件） */
const DEFAULT_PRICES_URL = new URL("../prices.default.json", import.meta.url);

/** 价单单价 → 每 token 纳元（price 小数≤3 位时精确为整数） */
export const nanoPerToken = (price) => Math.round((price ?? 0) * NANO_PER_CURRENCY_PER_TOK);

/** 纳元 → 显示字符串（去掉尾零，最多 9 位小数） */
export function formatNano(nano, symbol = "") {
  const s = (nano / NANO_SCALE).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return `${symbol}${s}`;
}

/** 纳元 → 显示字符串（保留 6 位小数，用于表格列） */
export function formatNano6(nano, symbol = "") {
  return `${symbol}${(nano / NANO_SCALE).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * 价单表。带 mtime 感知缓存：用户改了 prices.json 后自动重读，无需重启。
 */
export class PricingTable {
  /**
   * @param {string} file prices.json 路径
   * @param {object} [logger]
   */
  constructor(file, logger = console) {
    this.file = file;
    this.logger = logger;
    this.mtimeMs = 0;
    /** @type {{currency:string, symbol:string, rates:object[]}|null} */
    this.prices = null;
    this.loadError = null;
  }

  static async load(file, logger) {
    const t = new PricingTable(file, logger);
    await t.refreshIfChanged(true);
    return t;
  }

  /** 首次或文件变化时重读。force=true 忽略 mtime 强制读。 */
  async refreshIfChanged(force = false) {
    // 文件不存在的极端情况：不报错，保持兜底可用
    if (!existsSync(this.file)) {
      if (force) {
        this.prices = { currency: "CNY", symbol: "¥", rates: [] };
        this.loadError = `价单不存在：${this.file}`;
      }
      return;
    }
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch {
      return;
    }
    if (!force && stat.mtimeMs === this.mtimeMs) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj.rates)) throw new Error("prices.json 缺少 rates 数组");
      this.prices = obj;
      this.loadError = null;
      this.mtimeMs = stat.mtimeMs;
    } catch (err) {
      this.loadError = String(err.message ?? err);
      this.logger?.warn?.(`[usage-stats] 价单解析失败，沿用上次价单：${this.loadError}`);
    }
  }

  get currency() { return this.prices?.currency ?? "CNY"; }
  get symbol() { return this.prices?.symbol ?? "¥"; }

  /**
   * 匹配模型价。返回 {rate, match} 或 null。
   * 匹配顺序：provider 全等或 "*" 过滤后，exact 全等 → prefix 最长 → any 兜底。
   */
  findRate(provider, model) {
    if (!this.prices) return null;
    const m = String(model ?? "").trim().toLowerCase();
    if (!m) return null;
    const rates = this.prices.rates.filter((r) => r.provider === "*" || r.provider === provider);
    // 1) exact
    let best = rates.find((r) => r.match === "exact" && String(r.model).trim().toLowerCase() === m);
    if (best) return { rate: best, match: "exact" };
    // 2) prefix 最长命中（deepseek-v4-flash 命中 deepseek-v4-flash-0731）
    let longest = -1;
    for (const r of rates) {
      if (r.match !== "prefix") continue;
      const p = String(r.model).trim().toLowerCase();
      if (p.length > longest && m.startsWith(p)) { longest = p.length; best = r; }
    }
    if (best) return { rate: best, match: "prefix" };
    // 3) any 兜底
    const any = rates.find((r) => r.match === "any");
    if (any) return { rate: any, match: "any" };
    return null;
  }

  /** 对模型取"每 token 纳元"四档价（inputMiss/inputHit/output/cacheWrite），命中价外的返回 null */
  getPerToken(provider, model) {
    const hit = this.findRate(provider, model);
    if (!hit) return null;
    const r = hit.rate;
    const zero = (!Number(r.inputMiss) && !Number(r.inputHit) && !Number(r.output));
    return {
      match: hit.match,
      pricedModel: String(r.model),
      priced: !zero,
      inputMiss: nanoPerToken(Number(r.inputMiss)),
      inputHit: nanoPerToken(Number(r.inputHit)),
      output: nanoPerToken(Number(r.output)),
      cacheWrite: nanoPerToken(Number(r.cacheWrite ?? r.inputMiss)),
      note: r.note,
    };
  }
}

/**
 * 对一条采集记录做计价（就地改写 rec）。
 * 记录无需 usage（失败请求）→ cost=null、priced=false。
 * @param {PricingTable} table
 * @param {object} rec 采集记录（collector sink 产出）
 * @returns {object} rec
 */
export function rateRecord(table, rec) {
  const u = rec.usage;
  if (!u) {
    rec.cost = null;
    rec.priced = false;
    rec.pricedModel = null;
    rec.priceMatch = null;
    return rec;
  }
  const pt = table.getPerToken(rec.provider, rec.model);
  if (!pt) {
    rec.cost = null;
    rec.priced = false;
    rec.pricedModel = null;
    rec.priceMatch = null;
    rec.unpriced = true;
    return rec;
  }
  const tokens = (n) => Math.round(n ?? 0);
  const cost = {
    input: tokens(u.inputTokens) * pt.inputMiss,
    cacheRead: tokens(u.cacheReadTokens) * pt.inputHit,
    cacheWrite: tokens(u.cacheWriteTokens ?? 0) * pt.cacheWrite, // 无写价按 miss 价（保守）
    output: tokens(u.outputTokens) * pt.output,
  };
  cost.total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
  rec.cost = cost;
  rec.priced = !pt.priced ? false : true;
  rec.pricedModel = pt.priced ? pt.pricedModel : null;
  rec.priceMatch = pt.match;
  if (!pt.priced) rec.unpriced = true;
  return rec;
}

/** 确保 $DSH_HOME/usage/prices.json 存在（不存在则从内置默认价单拷贝），返回其路径 */
export async function ensurePricesFile(home, explicitPath) {
  const dir = path.join(home, "usage");
  const target = explicitPath ?? path.join(dir, "prices.json");
  await fs.mkdir(dir, { recursive: true });
  if (existsSync(target)) return target;
  try {
    const buf = await fs.readFile(fileURLToPath(DEFAULT_PRICES_URL));
    await fs.writeFile(target, buf, "utf8");
  } catch (err) {
    // 拷贝失败不致命：PricingTable 会按空价单退化为 unpriced
    console.warn(`[usage-stats] 拷贝初始价单失败：${err.message ?? err}`);
  }
  return target;
}