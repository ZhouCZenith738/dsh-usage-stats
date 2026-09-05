import * as os from "node:os";
import * as path from "node:path";

/**
 * $DSH_HOME 路径解析。
 *
 * 官方零依赖库 @deepseek-ai/dsh-home-paths 的语义（README.zh.md）：
 * 显式配置路径 > $DSH_HOME 环境变量 > ~/.dsh。
 * 插件运行时拿不到 launcher 的"显式配置路径"（那是启动进程自己的解析），
 * 因此这里以 dsh-home-paths 为准，读取失败（极端情况下依赖未装）时
 * 退化为 $DSH_HOME 或 ~/.dsh（与 DSH 默认部署一致）。
 */

let cached = null;

async function resolveDshHome() {
  if (cached) return cached;
  try {
    const mod = await import("@deepseek-ai/dsh-home-paths");
    const home = typeof mod.resolveDshHome === "function"
      ? mod.resolveDshHome()
      : (typeof mod.default?.resolveDshHome === "function" ? mod.default.resolveDshHome() : undefined);
    if (typeof home === "string" && home.length) {
      cached = home;
      return cached;
    }
  } catch {
    // 依赖缺失，走兜底
  }
  cached = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return cached;
}

/** 拼出 $DSH_HOME 下的相对路径，如 dshHomePath("usage", "usage-2026-09.jsonl") */
export async function dshHomePath(...rel) {
  const home = await resolveDshHome();
  return rel.length ? path.join(home, ...rel) : home;
}