/**
 * 采集层（核心挂点）。
 *
 * 所有 LLM 请求都经 ctx.llm.stream(...) 走 cordis waterfal("llm/stream")，
 * 我们注册一个 {global:true, prepend:true} 的监听器，回调拿到 (options, next)，
 * next() 返回内层流（async generator），返回"包装过的流"即可拦截观测 ——
 * 与既有先例同款：dsh-llm/lib/invariant.js 的 validateStream、
 * dsh-session-checkpoint-policy 的 afterCheckpoint。
 *
 * 协议不变式（dsh-llm README 声明）：流中必有一个 {type:'usage'} 分片先于
 * {type:'finish'} 分片；两适配器（官方/pi-ai）已把上游 usage 归一化为 disjoint
 * 4 桶（inputTokens 是不含缓存命中的 miss 输入）。因此我们：
 *   - 透传所有分片（绝不改写，防破坏 invariant 校验）；
 *   - 缓存最后出现的 usage 分片；
 *   - finish 时把 {provider, model, purpose, sessionId, usage, ok} 交给 sink 记账。
 *
 * 失败/中断路径可能没有 usage 分片：仍记 ok:false、usage:null 的行，保证请求数不丢。
 */

/** 判定 finish 是否算成功（error/aborted 除外） */
const OK_KINDS = new Set(["stop", "tool-calls", "max-tokens", "success"]);
const isOk = (kind) => OK_KINDS.has(kind);

let seq = 0;

const wrapStream = (options, inner, sink, logger) => {
  let usage;
  let startedAt = Date.now();
  return (async function* () {
    try {
      for await (const chunk of inner) {
        if (chunk?.type === "usage" && chunk.usage) usage = chunk.usage;
        yield chunk; // 原样透传
        if (chunk?.type === "finish") {
          const kind = chunk.reason?.kind ?? (chunk.reason ? "success" : "error");
          sink(makeRecord(options, { usage, ok: isOk(kind), finish: kind, ttftMs: undefined, startedAt }));
        }
      }
    } catch (err) {
      // 内层流异常抛出（异常路径而非 finish 分片）：补记失败行后原样抛给调用方
      try {
        sink(makeRecord(options, { usage: null, ok: false, finish: "error", startedAt }));
      } catch { /* 记账失败不影响抛错 */ }
      logger?.warn?.(`[usage-stats] llm 流异常，已记录失败行：${err.message ?? err}`);
      throw err;
    }
  })();
};

const makeRecord = (options, { usage, ok, finish, startedAt }) => {
  seq += 1;
  const t = Date.now();
  return {
    v: 1, // 记录格式版本
    id: `use-${process.pid.toString(36)}-${t.toString(36)}-${seq.toString(36)}`,
    t,
    provider: options.provider,                    // "deepseek-official" / pi-ai 路由键
    model: options.model,                          // 保留时间戳后缀，如 deepseek-v4-flash-0731
    purpose: options.purpose ?? "conversation",    // conversation | compaction | session-title ...
    sessionId: options.sessionId ?? null,
    ok,
    finish,                                       // stop | tool-calls | max-tokens | aborted | error
    usage: usage ?? null,                               // {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, totalTokens?, reasoningTokens?} | null（无 usage 显式存 null，保持 schema 稳定）
    estimated: false,                             // 未启用 token-meter 兜底；usage=null 即无真实数据
    startedAt,
    latencyMs: t - startedAt,
  };
};

/**
 * 安装采集器。
 * @param {object} ctx cordis 上下文
 * @param {(rec: object) => void} sink 记账回调（index.js 内先计价再落盘）
 * @param {object} [logger]
 */
export const installCollector = (ctx, sink, logger = console) => {
  ctx.on("llm/stream", (options, next) => {
    // 无条件包装所有流：conversation / compaction / session-title 都在花钱。
    const inner = next();
    if (!inner || typeof inner[Symbol.asyncIterator] !== "function") return inner;
    return wrapStream(options, inner, sink, logger);
  }, { global: true, prepend: true });
};