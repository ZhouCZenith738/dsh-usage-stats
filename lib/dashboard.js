/**
 * 仪表盘页面（self-contained HTML，零构建）。
 *
 * 一个独立静态页面：无需进入 dsh-web-app 的 SPA 构建链，
 * 由本插件经 ctx.webServer.register 挂到 /usage，
 * 页面内用 fetch 调同源 /usage/api/*（浏览器自动携带会话 cookie，
 * 与 SPA 走同一套 requestRejection 鉴权）。
 *
 * 视觉（frontend-design）：冷白纸面 + 全数字等宽（对账本直觉），
 * 唯一暖色（琥珀）只给费用线；签名元素 = 本月主卡费用大数字 count-up
 * + 三段消耗构成微条（输入/缓存命中/输出），仅此一处动效。
 */

export const renderDashboardHtml = () => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 用量统计</title>
<style>
  :root {
    --bg: #f7f8fa; --panel: #ffffff; --panel2: #f3f5f8;
    --line: #e4e8ee; --ink: #16202e; --muted: #64748b;
    --accent: #2456c4; --cost: #b45309;
    --ok: #16a34a; --bad: #dc2626;
    --seg-cache: #8ab2ef; --seg-out: #c9cfd8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
           padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line);
           position: sticky; top: 0; z-index: 5; }
  .title { font-size: 15px; font-weight: 600; }
  .controls { margin-left: auto; display: flex; gap: 10px; align-items: center; }
  .controls input, .controls select { background: var(--panel); color: var(--ink); border: 1px solid var(--line);
           border-radius: 8px; padding: 6px 10px; font: inherit; }
  .controls button { cursor: pointer; background: var(--panel); color: var(--ink);
           border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font: inherit; }
  .controls button:hover { border-color: var(--accent); color: var(--accent); }
  .controls #btn-refresh { background: var(--accent); border-color: var(--accent);
           color: #fff; font-weight: 600; }
  .controls #btn-refresh:hover { background: #1c47a8; border-color: #1c47a8; color: #fff; }

  main { padding: 16px 20px; max-width: 1200px; margin: 0 auto; }
  .banner { background: #fdf3e1; border: 1px solid #edd4a8; color: var(--cost);
            border-radius: 8px; padding: 9px 14px; margin-bottom: 14px; font-size: 13px; }
  .banner.hidden { display: none; }

  .cards { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) {
    .cards { grid-template-columns: 1fr 1fr; }
    .card-hero { grid-column: 1 / -1; }
  }
  @media (max-width: 600px) { .cards { grid-template-columns: 1fr; } }

  .card { position: relative; background: var(--panel); border: 1px solid var(--line);
          border-radius: 10px; padding: 16px 18px; }
  .card:hover { border-color: #cdd6e2; }
  .card-hero { box-shadow: 0 1px 2px rgba(22,32,46,.05); }
  .card-hero::before { content: ""; position: absolute; top: -1px; left: 18px; right: 18px;
                       height: 3px; border-radius: 0 0 3px 3px; background: var(--accent); }
  .card-eyebrow { font-size: 11px; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
  .card .big { font-size: 30px; font-weight: 700; line-height: 1.15;
               font-variant-numeric: tabular-nums; }
  .card-hero .big { font-size: 34px; }
  .card .comp { display: flex; height: 5px; margin: 10px 0 12px; border-radius: 3px; overflow: hidden; }
  .card .comp .seg { height: 100%; }
  .card .comp .seg-input { background: var(--accent); }
  .card .comp .seg-cache { background: var(--seg-cache); }
  .card .comp .seg-output { background: var(--seg-out); }
  .card .row { display: flex; justify-content: space-between; font-size: 13px;
               padding: 5px 0; border-top: 1px dashed var(--line); }
  .card .row:first-of-type { border-top: none; }
  .card .row .k { color: var(--muted); }

  section { margin-top: 18px; }
  h2 { font-size: 14px; margin: 0 0 8px; color: var(--muted); font-weight: 600; }
  .sec-head { display: flex; align-items: center; justify-content: space-between;
              gap: 12px; margin-bottom: 8px; }
  .sec-head h2 { margin: 0; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); }
  .legend .chip { display: inline-flex; align-items: center; gap: 6px; }
  .legend .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .legend .swatch.bar { background: var(--accent); }
  .legend .swatch.line { background: var(--cost); height: 3px; border-radius: 2px; }

  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: right; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  th:first-child, td:first-child { text-align: left; }
  th { background: var(--panel2); color: var(--muted); font-weight: 600; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #f8fafc; }
  td.empty { text-align: center; color: var(--muted); padding: 26px 12px; }
  td.unpriced { color: var(--cost); font-size: 12px; }

  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; line-height: 1.6; }
  .pill-ok { background: #e8f6ee; color: var(--ok); }
  .pill-bad { background: #fdebec; color: var(--bad); }

  .pager { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
  .pager button { background: var(--panel); color: var(--ink); border: 1px solid var(--line);
                  border-radius: 8px; padding: 5px 14px; cursor: pointer; font: inherit; }
  .pager button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .pager button:disabled { opacity: .45; cursor: default; }

  svg text { fill: var(--muted); font-size: 10px; }
  .mono { font-variant-numeric: tabular-nums; }
  .loading { color: var(--muted); font-size: 13px; padding: 6px 0; }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header>
  <div class="title">DSH 用量统计</div>
  <div class="controls">
    <label>模型
      <select id="model-filter">
        <option value="">全部模型</option>
      </select>
    </label>
    <label>从 <input type="date" id="from"></label>
    <label>到 <input type="date" id="to"></label>
    <button id="btn-refresh">刷新</button>
  </div>
</header>
<main>
  <div id="banner" class="banner hidden"></div>
  <section class="cards">
    <div class="card card-hero" id="card-month"><div class="loading">加载中…</div></div>
    <div class="card" id="card-today"><div class="loading">加载中…</div></div>
    <div class="card" id="card-range"><div class="loading">加载中…</div></div>
  </section>
  <section>
    <div class="sec-head">
      <h2>趋势</h2>
      <div class="legend">
        <span class="chip"><i class="swatch bar"></i>请求数</span>
        <span class="chip"><i class="swatch line"></i>费用</span>
      </div>
    </div>
    <div id="trend"><div class="loading">加载中…</div></div>
  </section>
  <section class="grid2">
    <div><h2>按模型</h2><table id="t-model"></table></div>
    <div><h2>按供应商</h2><table id="t-provider"></table></div>
  </section>
  <section>
    <h2>明细</h2>
    <table id="t-detail"></table>
    <div class="pager">
      <button id="btn-prev">上一页</button>
      <span id="page-info" class="mono"></span>
      <button id="btn-next">下一页</button>
      <button id="btn-edit-prices">编辑价格表</button>
      <span style="margin-left:auto;color:var(--muted);font-size:12px" id="detail-note"></span>
    </div>
  </section>
</main>
<script>
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const fmtInt = (n) => (n ?? 0).toLocaleString("zh-CN");
  const fmtCost = (nano, symbol) => symbol + (nano / 1e9).toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
  const fmtDt = (t) => { const d = new Date(t); return d.toLocaleString("zh-CN", { hour12: false }); };
  const localDayKey = (d) => { const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  const fmtReal = (n) => {
    const s = fmtInt(n);
    return n >= 10000 ? s + " ≈ " + (n / 1e4).toFixed(2) + " 万" : s;
  };
  const fmtPct = (r) => (r * 100).toFixed(2) + "%";
  // 右侧费用轴标签：最多 4 位小数，去尾零
  const fmtCostAxis = (nano, symbol) => symbol + (nano / 1e9).toFixed(4).replace(/0+$/, "").replace(/\\.$/, "");
  // "漂亮"刻度步长：1/2/5 × 10^k
  const niceStep = (raw) => {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const rem = raw / mag;
    return (rem <= 1 ? 1 : rem <= 2 ? 2 : rem <= 5 ? 5 : 10) * mag;
  };
  const localToday = () => localDayKey(new Date());
  const monthStart = (d) => d.slice(0, 8) + "01";

  const state = { from: null, to: null, afterId: null, symbol: "¥", model: "" };

  const api = async (p) => { const r = await fetch(p); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };

  // 表格构建（空 rows 时渲染跨列空态行，提示而非沉默）
  const table = (el, headers, rows, cell) => {
    const t = el.cloneNode(false);
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    headers.forEach((h) => { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    const tb = document.createElement("tbody");
    if (rows.length === 0) {
      const trE = document.createElement("tr");
      const tdE = document.createElement("td");
      tdE.className = "empty"; tdE.colSpan = headers.length;
      tdE.textContent = "该区间暂无记录，去跑一轮对话吧";
      trE.appendChild(tdE); tb.appendChild(trE);
    } else {
      for (const row of rows) { const r = cell(row); const tr2 = document.createElement("tr");
        r.forEach(({ text, cls }) => { const td = document.createElement("td"); td.textContent = text ?? "";
          if (cls) td.className = cls; tr2.appendChild(td); }); tb.appendChild(tr2); }
    }
    t.appendChild(tb);
    el.replaceWith(t);
  };

  // 主卡大数字 count-up（600ms ease-out；尊重 prefers-reduced-motion）
  const setBig = (el, nano, animate) => {
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduced) { el.textContent = fmtCost(nano, state.symbol); return; }
    const dur = 600, t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtCost(Math.round(nano * e), state.symbol);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // 三段消耗构成微条：输入/缓存命中/输出（缓存段不足 1% 时保底 2px 可见）
  const makeCompositionBar = (t) => {
    const bar = document.createElement("div");
    bar.className = "comp";
    const input = t.inputTokens ?? 0, cache = t.cacheReadTokens ?? 0, output = t.outputTokens ?? 0;
    const total = input + cache + output;
    if (!total) { bar.style.display = "none"; return bar; }
    const seg = (w, cls) => { const d = document.createElement("i"); d.className = "seg " + cls;
      d.style.width = w + "%"; bar.appendChild(d); };
    const cacheW = cache ? Math.max(2, cache / total * 100) : 0;
    const rest = input + output || 1;
    const inputW = input / rest * (100 - cacheW);
    seg(inputW, "seg-input");
    if (cacheW) seg(cacheW, "seg-cache");
    seg(100 - cacheW - inputW, "seg-output");
    bar.title = "输入 " + fmtInt(input) + " · 缓存命中 " + fmtInt(cache) + " · 输出 " + fmtInt(output);
    return bar;
  };

  const renderCard = (id, ov) => {
    const c = $("#" + id);
    const t = ov.tokens, cost = ov.cost;
    const isHero = id === "card-month";
    const rows = [
      ["请求", fmtInt(ov.requests) + "（成功 " + fmtInt(ov.okRequests) + "）"],
      ["真实消耗 Tokens", fmtReal(t.realTotal ?? 0)],
      ["缓存命中率", fmtPct(t.cacheHitRate ?? 0)],
      ["输入 / 输出", fmtInt(t.inputTokens) + " / " + fmtInt(t.outputTokens)],
      ["缓存读 / 写", fmtInt(t.cacheReadTokens) + " / " + fmtInt(t.cacheWriteTokens)],
    ];
    c.innerHTML = '<div class="card-eyebrow">' + c.dataset.title + '</div>';
    const big = document.createElement("div");
    big.className = "big mono";
    c.appendChild(big);
    setBig(big, cost.total, isHero);
    if (isHero) c.appendChild(makeCompositionBar(t));
    rows.forEach(([k, v]) => {
      const div = document.createElement("div"); div.className = "row";
      const kk = document.createElement("span"); kk.className = "k"; kk.textContent = k;
      const vv = document.createElement("span"); vv.className = "mono"; vv.textContent = v;
      div.appendChild(kk); div.appendChild(vv); c.appendChild(div);
    });
  };

  const drawTrend = (byDay, fromKey, toKey) => {
    const wrap = $("#trend"); wrap.textContent = "";
    // 按 from..to 补全空天：柱间距正确（缺哪天画零值柱），单日/少日数据不会撑成整块蓝
    const dayMap = new Map(byDay.map((d) => [d.day, d]));
    const days = [];
    if (fromKey && toKey) {
      const cur = new Date(fromKey + "T00:00:00");
      const end = new Date(toKey + "T00:00:00");
      for (; cur.getTime() <= end.getTime(); cur.setDate(cur.getDate() + 1)) {
        const k = localDayKey(cur);
        days.push(dayMap.get(k) ?? { day: k, requests: 0, cost: { total: 0 } });
      }
    } else {
      days.push(...byDay);
    }
    if (days.length === 0) { wrap.textContent = "区间内暂无数据"; return; }
    const W = 940, H = 200, P = { t: 18, r: 68, b: 26, l: 46 }, iw = W - P.l - P.r, ih = H - P.t - P.b;
    const maxR = Math.max(...days.map(d => d.requests), 1);
    const maxC = Math.max(...days.map(d => d.cost.total), 1);
    const cStep = maxC > 0 ? niceStep(maxC / 4) : 1;
    const roundStep = (v, s) => Math.round(v / s) * s;
    const n = days.length, bw = iw / n, barW = Math.min(bw - 4, 36);
    // 平滑费用曲线：Catmull-Rom → 三次贝塞尔；控制点 y 夹在绘图区内防扎出
    const clampY = (y) => Math.min(P.t + ih, Math.max(P.t, y));
    const smoothPath = (pts) => {
      if (pts.length < 3) return "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
      let d = "M" + pts[0][0].toFixed(1) + "," + pts[0][1].toFixed(1);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
        d += " C" + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) + " " + p2[0].toFixed(1) + "," + p2[1].toFixed(1);
      }
      return d;
    };
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.style.width = "100%"; svg.style.height = "auto";
    // 网格（左轴=请求数，右轴=费用）
    let lastRight = null;
    for (let i = 0; i <= 4; i++) {
      const y = P.t + ih * i / 4;
      const l = document.createElementNS(svgNS, "line");
      l.setAttribute("x1", P.l); l.setAttribute("y1", y); l.setAttribute("x2", W - P.r); l.setAttribute("y2", y);
      l.setAttribute("stroke", "#e8ecf2"); svg.appendChild(l);
      const tx = document.createElementNS(svgNS, "text");
      tx.setAttribute("x", P.l - 4); tx.setAttribute("y", y + 3); tx.setAttribute("text-anchor", "end");
      tx.textContent = fmtInt(Math.round(maxR * (4 - i) / 4)); svg.appendChild(tx);
      if (maxC > 0) {
        const cv = Math.min(maxC, roundStep(maxC * (4 - i) / 4, cStep));
        if (cv !== lastRight) {
          const tx2 = document.createElementNS(svgNS, "text");
          tx2.setAttribute("x", W - P.r + 6); tx2.setAttribute("y", y + 3); tx2.setAttribute("text-anchor", "start");
          tx2.textContent = fmtCostAxis(cv, state.symbol); svg.appendChild(tx2);
          lastRight = cv;
        }
      }
    }
    // 柱（请求）+ 线（费用）
    const pts = [];
    days.forEach((d, i) => {
      const cx = P.l + i * bw + bw / 2;
      const h = d.requests / maxR * ih;
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", String(cx - barW / 2)); rect.setAttribute("y", String(P.t + ih - h));
      rect.setAttribute("width", String(barW)); rect.setAttribute("height", String(h));
      rect.setAttribute("rx", "2"); rect.setAttribute("fill", "#2456c4"); rect.setAttribute("opacity", "0.8");
      svg.appendChild(rect);
      pts.push([cx, P.t + ih - d.cost.total / maxC * ih]);
      const lx = document.createElementNS(svgNS, "text");
      lx.setAttribute("x", String(cx)); lx.setAttribute("y", String(H - 8));
      lx.setAttribute("text-anchor", "middle");
      if (n <= 31 || i % Math.ceil(n / 12) === 0) lx.textContent = d.day.slice(5);
      svg.appendChild(lx);
    });
    // 费用线（≥3 点平滑贝塞尔，否则直线段）
    const line = document.createElementNS(svgNS, "path");
    line.setAttribute("d", smoothPath(pts));
    line.setAttribute("fill", "none"); line.setAttribute("stroke", "#b45309"); line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    wrap.appendChild(svg);
  };

  const renderTables = (ov) => {
    table($("#t-model"), ["模型", "请求", "输入", "输出", "缓存", "费用", ""], ov.byModel, (m) => [
      { text: m.model }, { text: fmtInt(m.requests) },
      { text: fmtInt(m.tokens.inputTokens) }, { text: fmtInt(m.tokens.outputTokens) },
      { text: fmtInt(m.tokens.cacheReadTokens) + "/" + fmtInt(m.tokens.cacheWriteTokens) },
      { text: fmtCost(m.cost.total, state.symbol) },
      { text: m.unpriced ? "· 未定价" : "", cls: m.unpriced ? "unpriced" : "" },
    ]);
    table($("#t-provider"), ["供应商", "请求", "输入", "输出", "费用"], ov.byProvider, (p) => [
      { text: p.provider }, { text: fmtInt(p.requests) },
      { text: fmtInt(p.tokens.inputTokens) }, { text: fmtInt(p.tokens.outputTokens) },
      { text: fmtCost(p.cost.total, state.symbol) },
    ]);
  };

  const renderDetail = (rows, note) => {
    table($("#t-detail"),
      ["时间", "供应商", "模型", "用途", "输入", "输出", "缓存", "费用", "状态"],
      rows, (r) => [
        { text: fmtDt(r.t) }, { text: r.provider }, { text: r.model },
        { text: r.purpose ?? "conversation" },
        { text: r.usage ? fmtInt(r.usage.inputTokens) : "-" },
        { text: r.usage ? fmtInt(r.usage.outputTokens) : "-" },
        { text: r.usage ? fmtInt((r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0)) : "-" },
        { text: r.cost ? fmtCost(r.cost.total, state.symbol) : "—" },
        { text: r.ok ? "成功" : (r.finish ?? "失败"), cls: r.ok ? "pill pill-ok" : "pill pill-bad" },
      ]);
    $("#detail-note").textContent = note ?? "";
  };

  const ranges = (from, to) => "/usage/api/overview?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to)
    + (state.model ? "&model=" + encodeURIComponent(state.model) : "");

  const load = async () => {
    state.from = state.from || monthStart(localToday());
    state.to = state.to || localToday();
    $("#from").value = state.from; $("#to").value = state.to;
    const today = localToday();
    const [ov, ovT, ovM] = await Promise.all([
      api(ranges(state.from, state.to)), api(ranges(today, today)), api(ranges(monthStart(today), today)),
    ]);
    state.symbol = ov.cost.symbol;
    setCard("card-month", ovM, "本月");
    setCard("card-today", ovT, "今日");
    setCard("card-range", ov, "所选区间");
    drawTrend(ov.byDay, state.from, state.to);
    renderTables(ov);
    const banner = $("#banner");
    if (ov.unpriced.length) {
      banner.classList.remove("hidden");
      banner.textContent = "有未定价模型，费用按 0 计入：" + ov.unpriced.map(u => u.model + "×" + u.count).join("、")
        + " —— 请编辑 $DSH_HOME/usage/prices.json 补充价格规则。";
    } else banner.classList.add("hidden");
    state.afterId = null;
    loadDetail();
  };

  const setCard = (id, ov, title) => {
    const c = $("#" + id); c.dataset.title = title; renderCard(id, ov);
  };

  const loadDetail = async () => {
    const q = "/usage/api/requests?from=" + encodeURIComponent(state.from) + "&to=" + encodeURIComponent(state.to)
      + "&limit=50" + (state.afterId ? "&afterId=" + encodeURIComponent(state.afterId) : "")
      + (state.model ? "&model=" + encodeURIComponent(state.model) : "");
    const req = await api(q);
    renderDetail(req.rows, state.afterId ? "已加载更多" : "最新 " + req.rows.length + " 条" + (state.model ? "（仅 " + state.model + "）" : ""));
    $("#btn-prev").disabled = !state.afterId;
    $("#btn-next").disabled = !req.hasMore;
    state.nextId = req.nextAfterId;
  };

  // 模型下拉：从 /usage/api/models 取近 90 天出现过的模型名，按名称去重
  const loadModels = async () => {
    try {
      const m = await api("/usage/api/models");
      const names = [...new Set((m.rows || []).map((r) => r.model).filter(Boolean))].sort();
      const sel = $("#model-filter");
      names.forEach((nm) => {
        const opt = document.createElement("option");
        opt.value = nm; opt.textContent = nm;
        sel.appendChild(opt);
      });
      sel.value = state.model || "";
    } catch { /* 下拉加载失败不阻塞页面 */ }
  };

  $("#btn-refresh").onclick = load;
  $("#from").onchange = (e) => { state.from = e.target.value; load(); };
  $("#to").onchange = (e) => { state.to = e.target.value; load(); };
  $("#model-filter").onchange = (e) => { state.model = e.target.value; load(); };
  $("#btn-prev").onclick = () => { state.afterId = null; loadDetail(); };
  $("#btn-next").onclick = () => { state.afterId = state.nextId; loadDetail(); };
  // 编辑价格表：让服务端用系统默认程序打开 prices.json（浏览器无法直接开本地 file://）
  $("#btn-edit-prices").onclick = async () => {
    try {
      const r = await api("/usage/api/open-prices");
      $("#detail-note").textContent = "已用系统默认程序打开 " + r.file;
    } catch (e) {
      $("#detail-note").textContent = "打开失败：" + e.message;
    }
  };

  loadModels();
  load().catch((e) => {
    document.querySelectorAll(".loading").forEach((n) => n.textContent = "加载失败：" + e.message);
  });
})();
</script>
</body>
</html>`;