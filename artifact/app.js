(() => {
  "use strict";

  const SITE_URL = "https://cbrdtora-web.github.io/jp-sector-fund-flow/";

  const PERIODS = [
    { key: "1w", label: "1週間", days: 7 },
    { key: "1m", label: "1ヶ月", days: 30 },
    { key: "1y", label: "1年", days: 365 },
    { key: "3y", label: "3年", days: 365 * 3 },
    { key: "5y", label: "5年", days: 365 * 5 },
    { key: "10y", label: "10年", days: 365 * 10 },
    { key: "all", label: "全期間", days: null },
  ];

  // 資金流入指数のような桁の大きい数値を「億」「兆」などの単位で読みやすくする。
  function formatCompactJP(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    const sign = value < 0 ? "-" : "";
    const abs = Math.abs(value);
    const trim = (n) => {
      const rounded = Math.round(n * 10) / 10;
      return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
    };
    if (abs >= 1e12) return `${sign}${trim(abs / 1e12)}兆`;
    if (abs >= 1e8) return `${sign}${trim(abs / 1e8)}億`;
    if (abs >= 1e4) return `${sign}${trim(abs / 1e4)}万`;
    return `${sign}${trim(abs)}`;
  }

  function formatValueForAxis(value, valueKey) {
    if (valueKey === "close") return value.toLocaleString("ja-JP");
    return formatCompactJP(value);
  }

  let tree = null;
  const seriesCache = new Map();
  let charts = [];
  let periodKey = "all";

  let view = { mode: "top" };
  let path = [{ id: "TOP", name: "全業種(33業種)" }];

  const sanitize = (id) => id.replace(/:/g, "__").replace(/\//g, "_");
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function isDarkMode() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function colorForIndex(i, total, dark) {
    const hue = Math.round((360 / Math.max(total, 1)) * i);
    const sat = 68;
    const light = dark ? 64 : 44;
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  // TradingViewのようなクロスヘア(十字線)をマウス位置に追従して描画するプラグイン。
  // 個別系列のツールチップ表示(nearest/intersect)とは独立して動作する。
  const crosshairPlugin = {
    id: "crosshair",
    afterInit(chart) {
      chart._crosshair = { x: 0, y: 0, active: false };
    },
    afterEvent(chart, args) {
      const { event } = args;
      const area = chart.chartArea;
      if (!area) return;
      if (event.type === "mousemove" || event.type === "mouseover") {
        const inside =
          event.x >= area.left && event.x <= area.right && event.y >= area.top && event.y <= area.bottom;
        chart._crosshair = { x: event.x, y: event.y, active: inside };
        args.changed = true;
      } else if (event.type === "mouseout") {
        if (chart._crosshair.active) args.changed = true;
        chart._crosshair.active = false;
      }
    },
    afterDraw(chart) {
      const cross = chart._crosshair;
      if (!cross || !cross.active) return;
      const { ctx, chartArea: area, scales } = chart;
      const lineColor = cssVar("--text-muted") || "#999999";
      const labelBg = cssVar("--series-1") || "#2a78d6";

      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      ctx.beginPath();
      ctx.moveTo(cross.x, area.top);
      ctx.lineTo(cross.x, area.bottom);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(area.left, cross.y);
      ctx.lineTo(area.right, cross.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const drawLabel = (text, boxX, boxY, boxW, boxH) => {
        ctx.fillStyle = labelBg;
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(text, boxX + 5, boxY + boxH / 2 + 0.5);
      };

      ctx.font = "11px system-ui, -apple-system, sans-serif";

      const xScale = scales.x;
      if (xScale) {
        const idx = Math.round(xScale.getValueForPixel(cross.x));
        const label = xScale.getLabelForValue(idx) ?? "";
        const boxW = ctx.measureText(label).width + 10;
        const boxH = 18;
        const boxX = Math.max(area.left, Math.min(cross.x - boxW / 2, area.right - boxW));
        drawLabel(label, boxX, area.bottom + 2, boxW, boxH);
      }

      const yScale = scales.y;
      if (yScale) {
        const value = yScale.getValueForPixel(cross.y);
        const label = formatValueForAxis(value, chart._valueKey);
        const boxW = ctx.measureText(label).width + 10;
        const boxH = 18;
        const boxX = Math.max(0, area.left - boxW - 2);
        const boxY = Math.min(Math.max(cross.y - boxH / 2, area.top), area.bottom - boxH);
        drawLabel(label, boxX, boxY, boxW, boxH);
      }

      ctx.restore();
    },
  };
  if (window.Chart) Chart.register(crosshairPlugin);

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`fetch failed: ${path}`);
    return res.json();
  }

  async function getSeries(nodeId) {
    if (seriesCache.has(nodeId)) return seriesCache.get(nodeId);
    const records = await fetchJson(`data/series/${sanitize(nodeId)}.json`);
    seriesCache.set(nodeId, records);
    return records;
  }

  async function getSeriesBatch(nodeIds, concurrency = 10) {
    const out = new Map();
    let idx = 0;
    async function worker() {
      while (idx < nodeIds.length) {
        const i = idx++;
        const id = nodeIds[i];
        try {
          out.set(id, await getSeries(id));
        } catch (e) {
          console.error(e);
          out.set(id, []);
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, nodeIds.length) }, worker);
    await Promise.all(workers);
    return out;
  }

  function applyPeriod(records, valueKey, rebase) {
    if (!records || records.length === 0) return [];
    let windowed = records;
    if (periodKey !== "all") {
      const days = PERIODS.find((p) => p.key === periodKey).days;
      const lastDate = new Date(records[records.length - 1].date);
      const cutoff = new Date(lastDate);
      cutoff.setDate(cutoff.getDate() - days);
      windowed = records.filter((r) => new Date(r.date) >= cutoff);
    }
    if (rebase && windowed.length > 0) {
      const base = windowed[0][valueKey] ?? 0;
      windowed = windowed.map((r) => ({ ...r, [valueKey]: (r[valueKey] ?? 0) - base }));
    }
    return windowed;
  }

  function renderPeriodControl() {
    const el = document.getElementById("period-control");
    el.innerHTML = "";
    for (const p of PERIODS) {
      const btn = document.createElement("button");
      btn.textContent = p.label;
      btn.className = "period-btn" + (p.key === periodKey ? " active" : "");
      btn.addEventListener("click", () => {
        periodKey = p.key;
        render();
      });
      el.appendChild(btn);
    }
  }

  function setBreadcrumb() {
    const el = document.getElementById("breadcrumb");
    el.innerHTML = "";
    path.forEach((p, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = " › ";
        el.appendChild(sep);
      }
      if (i === path.length - 1) {
        const span = document.createElement("span");
        span.className = "current";
        span.textContent = p.name;
        el.appendChild(span);
      } else {
        const btn = document.createElement("button");
        btn.textContent = p.name;
        btn.addEventListener("click", () => navigateTo(i));
        el.appendChild(btn);
      }
    });
  }

  function navigateTo(pathIndex) {
    path = path.slice(0, pathIndex + 1);
    const target = path[path.length - 1];
    view = target.id === "TOP" ? { mode: "top" } : { mode: "sector", sectorId: target.id };
    render();
  }

  function destroyCharts() {
    for (const c of charts) c.destroy();
    charts = [];
  }

  // TradingViewと同様に、ズーム/パンで見えている範囲のデータに合わせてY軸を
  // 自動的に伸縮させる(表示中の全系列の最小値〜最大値にフィット)。
  function rescaleYToVisibleRange(chart) {
    const xScale = chart.scales.x;
    if (!xScale) return;
    const minIndex = Math.max(0, Math.floor(xScale.min));
    const maxIndex = Math.min(chart.data.labels.length - 1, Math.ceil(xScale.max));
    let min = Infinity;
    let max = -Infinity;
    chart.data.datasets.forEach((ds, i) => {
      if (chart.getDatasetMeta(i).hidden) return;
      for (let idx = minIndex; idx <= maxIndex; idx++) {
        const v = ds.data[idx];
        if (v === null || v === undefined) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    if (min === Infinity) return;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    chart.options.scales.y.min = min - pad;
    chart.options.scales.y.max = max + pad;
    chart.update("none");
  }

  function baseLineOptions(valueKey) {
    return {
      responsive: true,
      animation: false,
      interaction: { mode: "nearest", intersect: true },
      scales: {
        x: {
          grid: { color: cssVar("--gridline"), drawTicks: false },
          ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          border: { color: cssVar("--baseline") },
        },
        y: {
          grid: { color: cssVar("--gridline"), drawTicks: false },
          ticks: {
            color: cssVar("--text-muted"),
            callback: (value) => formatValueForAxis(value, valueKey),
          },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar("--surface-1"),
          titleColor: cssVar("--text-primary"),
          bodyColor: cssVar("--text-secondary"),
          borderColor: cssVar("--border"),
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              const formatted = v === null || v === undefined ? "-" : formatValueForAxis(v, valueKey);
              return `${ctx.dataset.label}: ${formatted}`;
            },
          },
        },
        // TradingViewと同様に、マウスホイールでズーム、ドラッグでパンできるようにする。
        // パン/ズームのたびにY軸を表示範囲に合わせて伸縮させ(縦横ともに追従)、
        // ダブルクリックで元の表示範囲に戻る(renderMultiLineChart側でresetZoomを紐付け)。
        zoom: {
          pan: {
            enabled: true,
            mode: "x",
            onPanComplete: ({ chart }) => rescaleYToVisibleRange(chart),
          },
          zoom: {
            wheel: { enabled: true, speed: 0.1 },
            pinch: { enabled: true },
            mode: "x",
            onZoomComplete: ({ chart }) => rescaleYToVisibleRange(chart),
          },
          limits: { x: { minRange: 5 } },
        },
      },
    };
  }

  function renderMultiLineChart(container, title, entries, valueKey, rebase, onLegendClick) {
    const card = document.createElement("section");
    card.className = "chart-card";
    const h2 = document.createElement("h2");
    h2.textContent = title;
    card.appendChild(h2);

    const wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    const canvas = document.createElement("canvas");
    canvas.height = 120;
    wrap.appendChild(canvas);
    card.appendChild(wrap);

    const legendEl = document.createElement("div");
    legendEl.className = "chart-legend";
    card.appendChild(legendEl);

    container.appendChild(card);

    const dark = isDarkMode();
    const datasets = [];
    let labels = [];

    entries.forEach((entry, i) => {
      const filtered = applyPeriod(entry.records, valueKey, rebase);
      if (filtered.length > labels.length) labels = filtered.map((r) => r.date);
      const color = colorForIndex(i, entries.length, dark);
      datasets.push({
        label: entry.name,
        _nodeId: entry.id,
        data: filtered.map((r) => r[valueKey] ?? null),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.12,
        spanGaps: true,
      });
    });

    const chart = new Chart(canvas, { type: "line", data: { labels, datasets }, options: baseLineOptions(valueKey) });
    chart._valueKey = valueKey; // クロスヘアのY軸ラベル表示(億/兆)に使う
    charts.push(chart);

    // TradingViewと同じくダブルクリックでズーム/パン(Y軸の自動伸縮含む)をリセットする。
    canvas.addEventListener("dblclick", () => {
      chart.resetZoom();
      delete chart.options.scales.y.min;
      delete chart.options.scales.y.max;
      chart.update();
    });

    datasets.forEach((ds, i) => {
      const chip = document.createElement("button");
      chip.className = "legend-chip";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = ds.borderColor;
      chip.appendChild(swatch);
      const label = document.createElement("span");
      label.textContent = ds.label;
      chip.appendChild(label);

      chip.addEventListener("click", () => {
        if (onLegendClick) {
          onLegendClick(ds._nodeId);
        } else {
          const meta = chart.getDatasetMeta(i);
          meta.hidden = !meta.hidden;
          chip.classList.toggle("dimmed", !!meta.hidden);
          chart.update();
        }
      });
      legendEl.appendChild(chip);
    });
  }

  function renderStockNotice(container, label) {
    const card = document.createElement("section");
    card.className = "chart-card notice-card";
    card.innerHTML = `
      <h2>個別銘柄チャートについて</h2>
      <p>「${label}」に含まれる個別銘柄のチャートは、データ量の都合上この簡易版には含まれていません。</p>
      <p><a href="${SITE_URL}" target="_blank" rel="noopener">フル機能版(個別銘柄の資金流入指数・株価チャート)を見る →</a></p>
    `;
    container.appendChild(card);
  }

  function sectorSubdivision(sectorId) {
    const sector = tree.nodes[sectorId];
    const themeChildren = sector.children.map((id) => tree.nodes[id]).filter((n) => n && n.level === "theme");
    const subthemeNodes = themeChildren.flatMap((th) =>
      th.children.map((id) => tree.nodes[id]).filter((n) => n && n.level === "subtheme")
    );
    return { themeChildren, subthemeNodes };
  }

  async function renderTop() {
    const chartArea = document.getElementById("chart-area");
    chartArea.innerHTML = '<p class="loading">読み込み中…</p>';

    const sector33Ids = Object.values(tree.nodes)
      .filter((n) => n.level === "sector33")
      .sort((a, b) => b.count - a.count)
      .map((n) => n.id);

    const dataMap = await getSeriesBatch(sector33Ids);
    chartArea.innerHTML = "";
    destroyCharts();

    const entries = sector33Ids.map((id) => ({ id, name: tree.nodes[id].name, records: dataMap.get(id) || [] }));
    renderMultiLineChart(chartArea, "資金流入指数: 33業種の比較", entries, "flow", true, (nodeId) => {
      const node = tree.nodes[nodeId];
      view = { mode: "sector", sectorId: nodeId };
      path = [path[0], { id: nodeId, name: node.name }];
      render();
    });
  }

  async function renderSector(sectorId) {
    const chartArea = document.getElementById("chart-area");
    chartArea.innerHTML = '<p class="loading">読み込み中…</p>';

    const { themeChildren, subthemeNodes } = sectorSubdivision(sectorId);
    const sectorName = tree.nodes[sectorId].name;

    if (themeChildren.length === 0) {
      chartArea.innerHTML = "";
      destroyCharts();
      renderStockNotice(chartArea, sectorName);
      return;
    }

    const dataMap = await getSeriesBatch(themeChildren.map((n) => n.id).concat(subthemeNodes.map((n) => n.id)));
    chartArea.innerHTML = "";
    destroyCharts();

    const themeEntries = themeChildren.map((n) => ({ id: n.id, name: n.name, records: dataMap.get(n.id) || [] }));
    renderMultiLineChart(chartArea, "資金流入指数: テーマ別", themeEntries, "flow", true, (nodeId) => drillInto(nodeId));

    if (subthemeNodes.length > 0) {
      const subEntries = subthemeNodes.map((n) => ({
        id: n.id,
        name: `${tree.nodes[n.parent].name}・${n.name}`,
        records: dataMap.get(n.id) || [],
      }));
      renderMultiLineChart(chartArea, "資金流入指数: サブテーマ別", subEntries, "flow", true, (nodeId) => drillInto(nodeId));
    } else {
      renderStockNotice(chartArea, sectorName);
    }
  }

  function drillInto(nodeId) {
    const node = tree.nodes[nodeId];
    const chartArea = document.getElementById("chart-area");
    path = [path[0], path[1], { id: nodeId, name: node.name }];
    setBreadcrumb();
    chartArea.innerHTML = "";
    destroyCharts();
    renderStockNotice(chartArea, node.name);
  }

  async function render() {
    setBreadcrumb();
    renderPeriodControl();

    if (view.mode === "top") {
      await renderTop();
    } else if (view.mode === "sector") {
      await renderSector(view.sectorId);
    }
  }

  async function init() {
    const [treeData, meta] = await Promise.all([
      fetchJson("data/tree.json"),
      fetchJson("data/meta.json").catch(() => null),
    ]);
    tree = treeData;
    if (meta) {
      document.getElementById("last-updated").textContent =
        `${meta.date_range[1]} (対象 ${meta.stock_count} 銘柄, 全期間 ${meta.date_range[0]} 〜 ${meta.date_range[1]})`;
    }
    await render();
  }

  init().catch((e) => {
    console.error(e);
    document.body.innerHTML = `<p style="padding:24px;color:#d03b3b;">データの読み込みに失敗しました。(${e.message})</p>`;
  });
})();
