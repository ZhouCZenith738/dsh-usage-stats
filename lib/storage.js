import * as fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

/**
 * 存储模块。
 *
 * 明细落盘：$DSH_HOME/usage/usage-YYYY-MM.jsonl（按月一分片，追加式）。
 * 写入用单 writer promise 链保证顺序（appendFile 在同一进程内交错写会乱序）。
 * 读取按需流式扫描（个人用量规模：月分片几千行，读时聚合成本可忽略），
 * 不做写时 rollup，省掉增量一致性逻辑。
 *
 * 保留策略：retentionMonths（默认 12），启动与月末轮换时清理过期分片。
 */

export const MAX_RECORD_BYTES = 8192;

/** 本地日期键 YYYY-MM-DD（用本地时区，不用 toISOString 的 UTC） */
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 月份键 YYYY-MM */
export function monthKeyOfDay(dayKeyStr) {
  return dayKeyStr.slice(0, 7);
}

/** 当日 0 点 ms */
export function startOfDayMs(dayKeyStr) {
  const [y, m, d] = dayKeyStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** (from, to) 两个日键 → [fromMs, toMsExcl) 区间，to 按"整天含"处理 */
export function rangeToMs(fromKey, toKey) {
  const fromMs = startOfDayMs(fromKey);
  const toMs = startOfDayMs(toKey) + 86400000;
  return [fromMs, toMs];
}

/** 递增枚举 from..to 之间所有月份键（含两端） */
export function monthKeysBetween(fromKey, toKey) {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export const monthFileName = (monthKey) => `usage-${monthKey}.jsonl`;

/** 明细存储：追加 + 区间迭代 + 清理 */
export class UsageStore {
  /** @param {string} home $DSH_HOME */
  constructor(home, logger = console) {
    this.dir = path.join(home, "usage");
    this.logger = logger;
    this.chain = Promise.resolve();
    this.lastFile = null;
  }

  fileFor(t) {
    const k = dayKey(t).slice(0, 7);
    return path.join(this.dir, monthFileName(k));
  }

  /** 追加一条记录（顺序保证）。返回当前写链 Promise。 */
  append(rec) {
    const line = JSON.stringify(rec);
    if (line.length > MAX_RECORD_BYTES) {
      this.logger?.warn?.(`[usage-stats] 记录超长（${line.length}B），跳过：${rec.id ?? ""}`);
      return Promise.resolve();
    }
    const file = this.fileFor(rec.t ?? Date.now());
    this.chain = this.chain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(file, line + "\n", "utf8");
      // month 轮换时顺手清过期分片
      if (this.lastFile !== file) {
        this.lastFile = file;
        await this.prune(12);
      }
    }).catch((err) => {
      this.logger?.warn?.(`[usage-stats] 写盘失败：${err.message ?? err}`);
    });
    return this.chain;
  }

  /** 清理早于 retentionMonths 的分片（默认 12 个月）。 */
  async prune(retentionMonths = 12) {
    try {
      const files = await fs.readdir(this.dir);
      const now = new Date();
      const cutoff = new Date(now.getFullYear(), now.getMonth() - retentionMonths, 1);
      const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;
      for (const f of files) {
        const m = /^usage-(\d{4}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cutoffKey) {
          await fs.unlink(path.join(this.dir, f)).catch(() => {});
          this.logger?.info?.(`[usage-stats] 清理过期分片：${f}`);
        }
      }
    } catch {
      // 目录不存在等：忽略
    }
  }

  /**
   * 迭代 [fromKey, toKey] 区间内所有记录（本地日键，含两端）。
   * @param {string} fromKey  YYYY-MM-DD
   * @param {string} toKey    YYYY-MM-DD
   */
  async *iterate(fromKey, toKey) {
    const [fromMs, toMs] = rangeToMs(fromKey, toKey);
    for (const mk of monthKeysBetween(fromKey, toKey)) {
      const file = path.join(this.dir, monthFileName(mk));
      if (!existsSync(file)) continue;
      const stream = createReadStream(file, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (typeof rec.t === "number" && rec.t >= fromMs && rec.t < toMs) yield rec;
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }
  }

  /** 一次取回区间内全部记录（明细分页/聚合用；个人规模内存可容纳） */
  async collect(fromKey, toKey) {
    const out = [];
    for await (const rec of this.iterate(fromKey, toKey)) out.push(rec);
    return out;
  }
}