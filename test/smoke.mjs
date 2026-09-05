/**
 * 集成冒烟测试（无 cordis 环境）。
 *
 * 用假的 ctx 直接调用插件 apply()，然后伪造一个 `llm/stream` 流：
 *   透传分片 → 捕获 usage → finish 记账 → 计价 → JSONL 落盘 → 读回核对。
 * 运行：node test/smoke.mjs
 * 退出码 0 = 通过。
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { apply } from "../lib/index.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-usage-smoke-"));
process.env.DSH_HOME = home;

// ---- 假 ctx：只实现本插件用到的面 ----
const listeners = new Map();
const fakeCtx = {
  logger: { info: () => {}, warn: (m) => console.warn("[warn]", m), error: (m) => console.error("[error]", m) },
  on(event, fn) {
    const arr = listeners.get(event) ?? [];
    arr.push(fn);
    listeners.set(event, arr);
    return () => {};
  },
  effect(fn) { const d = fn?.(); return typeof d === "function" ? d : () => {}; },
  webServer: {
    register(route) { console.log("[fake-ctx] 注册路由:", route.kind, route.path); return () => {}; },
  },
  connection: { requestRejection: () => undefined },
  commands: { register(def) { console.log("[fake-ctx] 注册命令:", def.name); } },
};

await apply(fakeCtx, {});
await new Promise((r) => setTimeout(r, 300)); // 等 home 解析 + 价单拷贝

// ---- 伪造 llm/stream ----
const streamListener = listeners.get("llm/stream")?.[0];
if (!streamListener) { console.error("FAIL: 未找到 llm/stream 监听器"); process.exit(1); }

const consume = async (options, inner) => {
  const wrapped = streamListener(options, () => inner);
  const chunks = [];
  for await (const c of wrapped) chunks.push(c);
  return chunks;
};

const readRecs = async () => {
  const dir = path.join(home, "usage");
  const files = await fs.readdir(dir);
  const out = [];
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const txt = await fs.readFile(path.join(dir, f), "utf8");
    for (const line of txt.trim().split("\n")) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
};

let fail = 0;
const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); fail += 1; } else console.log("ok -", msg); };

// 场景 1：正常流（usage + stop）
const options = { provider: "deepseek-official", model: "deepseek-v4-flash-0731", purpose: "conversation", sessionId: "s1" };
const chunks = await consume(options, (async function* () {
  yield { type: "block-start" };
  yield { type: "usage", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, totalTokens: 3500 } };
  yield { type: "finish", reason: { kind: "stop" } };
})());
check(chunks.length === 3, `正常流透传分片数 = ${chunks.length} (期望 3)`);

// 场景 2：错误流（无 usage）
await consume({ ...options, provider: "bailian", model: "qwen-max", purpose: "compaction" }, (async function* () {
  yield { type: "finish", reason: { kind: "error" } };
})());

// 场景 3：中断流（usage 之后 aborted）
await consume({ ...options, provider: "tokenriver", model: "deepseek-v4-pro-0813" }, (async function* () {
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  yield { type: "finish", reason: { kind: "aborted" } };
})());

await new Promise((r) => setTimeout(r, 300)); // 写链落盘

const recs = await readRecs();
check(recs.length === 3, `落盘记录数 = ${recs.length} (期望 3)`);

const r1 = recs.find((r) => r.model === "deepseek-v4-flash-0731" && r.ok);
check(r1?.ok === true && r1.finish === "stop", `场景1 状态 ok/stop`);
check(r1?.usage?.inputTokens === 1000 && r1?.usage?.cacheReadTokens === 2000, "场景1 usage 桶值完整");
// 1000×¥3/M + 2000×¥0.1/M + 500×¥9/M = 0.0077 元
check(Math.abs((r1.cost.total / 1e9) - (1000 * 3 + 2000 * 0.1 + 500 * 9) / 1e6) < 1e-12, `场景1 费用 = ${(r1.cost.total / 1e9).toFixed(6)} 元 (期望 0.007700)`);

const r2 = recs.find((r) => r.model === "qwen-max");
check(r2?.ok === false && r2?.usage === null && r2?.cost === null && r2?.priced === false, "场景2 错误流：ok=false / usage=null / cost=null / priced=false");

const r3 = recs.find((r) => r.model === "deepseek-v4-pro-0813");
check(r3?.ok === false && r3.usage !== null && r3.cost !== null, "场景3 中断流：无 usage 丢弃？→ 有 usage 则计费");

// 价单文件是否已拷贝
try { await fs.access(path.join(home, "usage", "prices.json")); check(true, "prices.json 已从内置价单拷贝"); }
catch { check(false, "prices.json 未拷贝"); }

// 清理
await fs.rm(home, { recursive: true, force: true });
if (fail > 0) { console.error(`\n${fail} 项失败`); process.exit(1); }
console.log("\n✅ 冒烟测试通过");