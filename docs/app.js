(() => {
  "use strict";

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
  // 株価(close)はそのまま桁区切り表示。
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
  const seriesCache = new Map(); // nodeId -> records[]
  let charts = []; // 現在表示中のChart.jsインスタンス

  let periodKey = "all";
  let metric = "flow"; // 'flow' | 'close' (銘柄一覧チャートのみ切り替え可能)

  // ナビゲーション状態: 'top' | 'sector' | 'stocks'
  let view = { mode: "top" };
  let path = [{ id: "TOP", name: "全業種(33業種)" }];

  const sanitize = (id) => id.replace(/:/g, "__").replace(/\//g, "_");
  // CSS変数は.viz-root(body要素)に定義されているため、documentElementではなくbodyを参照する。
  const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

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

  // JPXの市場区分表記(例:「プライム(内国株式)」)から短いラベルを取り出す。
  function shortMarketLabel(market) {
    if (market.includes("プライム")) return "プライム";
    if (market.includes("スタンダード")) return "スタンダード";
    if (market.includes("グロース")) return "グロース";
    return market;
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

  // 同時実行数を抑えつつ複数ノードの系列データをまとめて取得する
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

  function collectStockIds(nodeId) {
    const node = tree.nodes[nodeId];
    if (!node) return [];
    if (node.level === "stock") return [nodeId];
    return node.children.flatMap(collectStockIds);
  }

  // 期間フィルタ + 累積指標の場合は期間の起点をゼロに揃える(相対的な変化を見やすくする)
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

  function renderMetricControl() {
    const el = document.getElementById("metric-control");
    if (view.mode !== "stocks") {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = "";
    const options = [
      { key: "flow", label: "資金流入指数" },
      { key: "close", label: "株価" },
    ];
    for (const o of options) {
      const btn = document.createElement("button");
      btn.textContent = o.label;
      btn.className = "metric-btn" + (o.key === metric ? " active" : "");
      btn.addEventListener("click", () => {
        metric = o.key;
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
    if (target.id === "TOP") {
      view = { mode: "top" };
    } else if (path.length === 2) {
      view = { mode: "sector", sectorId: target.id };
    }
    render();
  }

  function destroyCharts() {
    for (const c of charts) c.destroy();
    charts = [];
  }

  function baseLineOptions(valueKey, showLegendTooltip) {
    const unitSuffix = valueKey === "close" ? "円" : "";
    const gridColor = cssVar("--grid-strong") || cssVar("--gridline");
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: true },
      scales: {
        x: {
          grid: { color: gridColor, drawTicks: false, lineWidth: 1 },
          ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          border: { color: cssVar("--baseline") },
        },
        y: {
          grid: { color: gridColor, drawTicks: false, lineWidth: 1 },
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
          enabled: showLegendTooltip !== false,
          backgroundColor: cssVar("--surface-1"),
          titleColor: cssVar("--text-primary"),
          bodyColor: cssVar("--text-secondary"),
          borderColor: cssVar("--border"),
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              const formatted = v === null || v === undefined ? "-" : `${formatValueForAxis(v, valueKey)}${unitSuffix}`;
              return `${ctx.dataset.label}: ${formatted}`;
            },
          },
        },
        // TradingViewと同様に、マウスホイールでズーム、ドラッグでパンできるようにする。
        // 通常はホイールで横(時間軸)方向にズームし、Y軸の目盛り部分の上で
        // ホイールすると縦(金額)方向だけズームできる。ドラッグは縦横どちらにも
        // 動かせる。ダブルクリックで元の表示範囲に戻る(renderMultiLineChart側で
        // resetZoomを紐付け)。
        zoom: {
          pan: { enabled: true, mode: "xy" },
          zoom: {
            wheel: { enabled: true, speed: 0.1 },
            pinch: { enabled: true },
            mode: "x",
            scaleMode: "y",
          },
          limits: { x: { minRange: 5 } },
        },
      },
    };
  }

  // 複数系列の折れ線チャートを1枚描画し、カスタム凡例を添える。
  // onLegendClick(nodeId) を渡すとクリックで遷移、渡さなければ表示/非表示トグル。
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

    const bulkControls = document.createElement("div");
    bulkControls.className = "legend-bulk-controls";
    bulkControls.hidden = true; // onLegendClickがない(銘柄一覧)場合のみ後で表示する
    card.appendChild(bulkControls);

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
        _market: entry.market ? shortMarketLabel(entry.market) : "",
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

    const chart = new Chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: baseLineOptions(valueKey),
    });
    chart._valueKey = valueKey; // クロスヘアのY軸ラベル表示(億/兆 or 円)の切り替えに使う
    charts.push(chart);

    // TradingViewと同じくダブルクリックでズーム/パン(Y軸の自動伸縮含む)をリセットする。
    canvas.addEventListener("dblclick", () => {
      chart.resetZoom();
      delete chart.options.scales.y.min;
      delete chart.options.scales.y.max;
      chart.update();
    });

    const chips = [];
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
          rescaleYToVisibleRange(chart);
        }
      });
      legendEl.appendChild(chip);
      chips.push(chip);
    });

    // 個別銘柄一覧(onLegendClickなし、線が多くなりがち)では、
    // 一括表示/非表示ボタンと市場区分(プライム/スタンダード/グロース)フィルタを出す。
    if (!onLegendClick) {
      const setAllHidden = (hidden) => {
        datasets.forEach((ds, i) => {
          chart.getDatasetMeta(i).hidden = hidden;
          chips[i].classList.toggle("dimmed", hidden);
        });
        chart.update();
        rescaleYToVisibleRange(chart);
      };

      const showAllBtn = document.createElement("button");
      showAllBtn.className = "bulk-btn";
      showAllBtn.textContent = "すべて表示";
      showAllBtn.addEventListener("click", () => setAllHidden(false));
      bulkControls.appendChild(showAllBtn);

      const hideAllBtn = document.createElement("button");
      hideAllBtn.className = "bulk-btn";
      hideAllBtn.textContent = "すべて非表示";
      hideAllBtn.addEventListener("click", () => setAllHidden(true));
      bulkControls.appendChild(hideAllBtn);

      const markets = [...new Set(datasets.map((ds) => ds._market).filter(Boolean))];
      if (markets.length > 0) {
        const sortOrder = ["プライム", "スタンダード", "グロース"];
        markets.sort((a, b) => sortOrder.indexOf(a) - sortOrder.indexOf(b));
        for (const market of markets) {
          const btn = document.createElement("button");
          btn.className = "bulk-btn market-btn active";
          btn.textContent = market;
          btn.addEventListener("click", () => {
            const nowActive = !btn.classList.contains("active");
            btn.classList.toggle("active", nowActive);
            datasets.forEach((ds, i) => {
              if (ds._market !== market) return;
              chart.getDatasetMeta(i).hidden = !nowActive;
              chips[i].classList.toggle("dimmed", !nowActive);
            });
            chart.update();
            rescaleYToVisibleRange(chart);
          });
          bulkControls.appendChild(btn);
        }
      }

      bulkControls.hidden = false;
    }

    return chart;
  }

  function sectorSubdivision(sectorId) {
    const sector = tree.nodes[sectorId];
    const themeChildren = sector.children
      .map((id) => tree.nodes[id])
      .filter((n) => n.level === "theme");
    const directStocks = sector.children
      .map((id) => tree.nodes[id])
      .filter((n) => n.level === "stock");
    const subthemeNodes = themeChildren.flatMap((th) =>
      th.children.map((id) => tree.nodes[id]).filter((n) => n.level === "subtheme")
    );
    return { themeChildren, directStocks, subthemeNodes };
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

    const { themeChildren, directStocks, subthemeNodes } = sectorSubdivision(sectorId);

    if (themeChildren.length === 0) {
      // これ以上の業種としての細分化はない → 直接この業種の全銘柄チャートへ
      await goToStockGroup(sectorId, tree.nodes[sectorId].name);
      return;
    }

    const themeIds = themeChildren.map((n) => n.id).concat(directStocks.map((n) => n.id));
    const subthemeIds = subthemeNodes.map((n) => n.id);
    const dataMap = await getSeriesBatch(themeIds.concat(subthemeIds));

    chartArea.innerHTML = "";
    destroyCharts();

    const themeEntries = themeIds.map((id) => ({ id, name: tree.nodes[id].name, records: dataMap.get(id) || [] }));
    renderMultiLineChart(chartArea, "資金流入指数: テーマ別", themeEntries, "flow", true, (nodeId) =>
      drillInto(nodeId)
    );

    if (subthemeNodes.length > 0) {
      const subEntries = subthemeNodes.map((n) => ({
        id: n.id,
        name: `${tree.nodes[n.parent].name}・${n.name}`,
        records: dataMap.get(n.id) || [],
      }));
      renderMultiLineChart(chartArea, "資金流入指数: サブテーマ別", subEntries, "flow", true, (nodeId) =>
        drillInto(nodeId)
      );
    }
  }

  function drillInto(nodeId) {
    const node = tree.nodes[nodeId];
    path = [path[0], path[1], { id: nodeId, name: `銘柄一覧: ${node.name}` }];
    goToStockGroup(nodeId, node.name);
  }

  async function goToStockGroup(nodeId, label) {
    view = { mode: "stocks", groupId: nodeId };
    if (path.length < 2 || path[path.length - 1].id !== nodeId) {
      // renderSector経由(細分化なし)の直接遷移用にpathを整える
      if (path.length === 2 && path[1].id !== nodeId) {
        path = [path[0], path[1], { id: nodeId, name: `銘柄一覧: ${label}` }];
      }
    }
    setBreadcrumb();
    renderMetricControl();

    const chartArea = document.getElementById("chart-area");
    chartArea.innerHTML = '<p class="loading">銘柄データを読み込み中…</p>';

    const stockIds = collectStockIds(nodeId);
    const dataMap = await getSeriesBatch(stockIds);

    chartArea.innerHTML = "";
    destroyCharts();

    const entries = stockIds.map((id) => ({
      id,
      name: tree.nodes[id].name,
      records: dataMap.get(id) || [],
      market: tree.nodes[id].market || "",
    }));
    const valueKey = metric === "close" ? "close" : "flow";
    const title = metric === "close" ? `株価: ${label}(${stockIds.length}銘柄)` : `資金流入指数: ${label}(${stockIds.length}銘柄)`;
    renderMultiLineChart(chartArea, title, entries, valueKey, metric === "flow", null);
  }

  async function render() {
    setBreadcrumb();
    renderPeriodControl();
    renderMetricControl();

    if (view.mode === "top") {
      await renderTop();
    } else if (view.mode === "sector") {
      await renderSector(view.sectorId);
    } else if (view.mode === "stocks") {
      await goToStockGroup(view.groupId, path[path.length - 1].name.replace(/^銘柄一覧: /, ""));
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
