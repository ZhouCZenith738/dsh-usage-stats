# dsh-usage-stats

Usage statistics plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, `@deepseek-ai/dsh`). It records the **real token usage** of every LLM request (from the upstream response), prices it against an editable rate card, persists records as JSONL, and renders them in a self-contained web dashboard plus a `/usage` slash command.

> The usage-statistics design is inspired by [cc-switch](https://github.com/farion1231/cc-switch) (response-layer usage capture, token normalization, per-million-token pricing, dashboard dimensions). The code is original and does not copy cc-switch. See License & Credits below.

## Features

- **Zero-intrusion capture**: hooks the `llm/stream` event on `ctx.llm.stream` (`{global:true, prepend:true}`), passes every chunk through untouched, and settles the account at the terminal chunk. Real tokens come from the `usage` chunk (emitted before the terminal chunk by protocol invariant). Both official adapter paths (direct DeepSeek / pi-ai compatible gateways) already normalize upstream usage into **disjoint buckets** — uncached input, cache-read, cache-write, output — so billing trusts the buckets directly; no manual `prompt_tokens` reconstruction.
- **Pricing**: editable rate card at `$DSH_HOME/usage/prices.json` — per-1M-token prices tuned per `provider`/`model` with `inputMiss` / `inputHit` / `output` / `cacheWrite`. Model ids with timestamp suffixes (`deepseek-v4-flash-0731`) are matched with `match:"prefix"` (longest hit wins). All math runs in integer *nano-units* (1 nano = 1e-9 of currency) so personal bills stay reproducible — no floating-point drift.
- **Storage**: one append-only JSONL per month at `$DSH_HOME/usage/usage-YYYY-MM.jsonl`; aggregation happens at read time (no SQLite needed at personal scale).
- **Dashboard**: a self-contained light-themed page at `/usage` — three summary cards with all-models / per-model drill-down, a requests×cost dual-axis smooth trend chart, per-model & per-provider tables, paginated request log, and a one-click "edit rate card" button. All endpoints sit behind the same session-cookie auth (`requestRejection`) as the host SPA.
- **Non-invasive**: no changes to dsh-llm / adapters / the SPA, no build chain; data lives entirely in `$DSH_HOME/usage/` — delete the folder to reset.

## Install (web profile)

```bash
# 1) Put this plugin folder somewhere convenient, then add it to the web profile's node_modules
cd "$DSH_HOME/profiles/web"
dsh plugin --profile web add "file:</absolute/path>/dsh-usage-stats"
#    On Windows, if the path contains spaces, use the 8.3 short name — or add the
#    dependency to package.json manually and run pnpm install.

# 2) Append a mount entry to the profile's cordis.patch.yml (never edit cordis.yml)
```

```yaml
- insert:
    - id: usage-stats
      name: dsh-usage-stats
      config:
        retentionMonths: 12
```

```bash
# 3) Restart dsh web (new npm dependencies need a full restart, hot reload is not enough)
dsh web
```

Uninstall: remove the `insert` block from `cordis.patch.yml`, run `dsh plugin --profile web remove dsh-usage-stats`, and restart.

## Usage

- **Dashboard**: log in to the host page, then open `http://127.0.0.1:3080/usage` (port depends on your deployment). The top bar switches between **All models / a specific model**, filters the date range, and the trend chart shows requests (left axis) vs cost (right axis).
- **Slash command**: `/usage` (no arguments) returns a month/today summary — tokens, cost, cache hit rate, and a link to the dashboard.
- **Edit the rate card**: the "Edit rate card" button below the log tells the server to open `prices.json` with the system default app. Save and the card hot-reloads (mtime-aware, no restart).

## Price card (`$DSH_HOME/usage/prices.json`)

Created automatically on first run from the bundled defaults. **Edit by hand; save to apply.** Units are **currency per 1M tokens**.

| Field | Meaning |
|---|---|
| `provider` | Route name (`deepseek-official`, `bailian`, `tokenriver`, …) or `"*"` wildcard |
| `model` | Base model name (`deepseek-v4-flash`) — `prefix` matching also covers `-0731`-style suffixes |
| `match` | `exact` / `prefix` (longest hit) / `any` (fallback) |
| `inputMiss` / `inputHit` / `output` / `cacheWrite` | Uncached input / cache-read / output / cache-write (defaults to `inputMiss`) |

```jsonc
{ "provider": "bailian", "model": "qwen-max", "match": "prefix",
  "inputMiss": 2.5, "inputHit": 0.3, "output": 7.5, "note": "example" }
```

Models that only match the `match:"any"` fallback with zero prices are billed at 0 and listed in the dashboard's "unpriced" section. **The bundled prices are the peak public rates at capture time — verify against the official pricing page or your provider's bill before trusting them.** Historical records keep the cost computed at write time; they are not repriced retroactively.

## Architecture

| File | Responsibility |
|---|---|
| `lib/index.js` | Plugin entry (Cordis function plugin: name/inject/apply) |
| `lib/collector.js` | Wraps the `llm/stream` stream and captures the `usage` chunk |
| `lib/pricing.js` | Rate-card loading / fuzzy matching / integer nano-unit pricing |
| `lib/storage.js` | Monthly JSONL append, ranged reads, retention pruning |
| `lib/aggregate.js` | Read-time aggregation (per-day / model / provider / unpriced) |
| `lib/http.js` | `/usage` page and `/usage/api/*` routes (auth + TTL cache) |
| `lib/dashboard.js` | Self-contained dashboard HTML |
| `lib/command.js` | `/usage` slash command |
| `lib/home.js` | `$DSH_HOME` resolution (falls back when the dependency is missing) |
| `test/smoke.mjs` | Host-less integration smoke test |

## Known limitations

- Failed/interrupted requests may carry no `usage` chunk: they still count as requests, billed at 0 (`usage: null`).
- Token buckets come from adapter normalization and do not backfill history — usage before installation is out of reach.
- The only runtime dependency, `@deepseek-ai/dsh-home-paths`, is currently a prerelease (`^0.1.2-rc.1`).
- The dashboard is a standalone page, not embedded in the host SPA sidebar (the host frontend ships prebuilt).

## License & Credits

MIT License — see [LICENSE](./LICENSE). Third-party attribution & credits in [NOTICE](./NOTICE.md):

- Runtime dependency **@deepseek-ai/dsh-home-paths** — MIT — © 2026 DeepSeek
- Design inspiration **cc-switch** (farion1231/cc-switch) — MIT — © 2025 Jason Young — <https://github.com/farion1231/cc-switch>