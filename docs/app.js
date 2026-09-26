(() => {
  "use strict";

  const LEVEL_LABEL = {
    root: "全業種",
    sector17: "業種(大分類)",
    sector33: "業種(中分類)",
    theme: "テーマ",
    subtheme: "サブテーマ",
    stock: "銘柄",
  };

  let tree = null;
  let currentId = null;
  let flowChart = null;
  let priceChart = null;

  const sanitize = (id) => id.replace(/:/g, "__").replace(/\//g, "_");
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`fetch failed: ${path}`);
    return res.json();
  }

  function setBreadcrumb(node) {
    const el = document.getElementById("breadcrumb");
    el.innerHTML = "";
    const path = [];
    let n = node;
    while (n) {
      path.unshift(n);
      n = n.parent ? tree.nodes[n.parent] : null;
    }
    path.forEach((n, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = " › ";
        el.appendChild(sep);
      }
      if (i === path.length - 1) {
        const span = document.createElement("span");
        span.className = "current";
        span.textContent = n.name;
        el.appendChild(span);
      } else {
        const btn = document.createElement("button");
        btn.textContent = n.name;
        btn.addEventListener("click", () => navigate(n.id));
        el.appendChild(btn);
      }
    });
  }

  function renderChildren(node) {
    const grid = document.getElementById("children-grid");
    const title = document.getElementById("children-title");
    grid.innerHTML = "";

    if (node.level === "stock" || node.children.length === 0) {
      title.textContent = "内訳";
      const p = document.createElement("p");
      p.style.color = "var(--text-muted)";
      p.style.fontSize = "13px";
      p.textContent = "これ以上の細分化はありません。上のチャートが個別銘柄のチャートです。";
      grid.appendChild(p);
      return;
    }

    title.textContent = node.level === "root"
      ? "業種を選択"
      : `内訳 (${node.children.length}件)`;

    const childNodes = node.children
      .map((id) => tree.nodes[id])
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));

    for (const child of childNodes) {
      const btn = document.createElement("button");
      btn.className = "child-btn";
      const name = document.createElement("span");
      name.className = "child-name";
      name.textContent = child.name;
      const meta = document.createElement("span");
      meta.className = "child-meta";
      meta.textContent = child.level === "stock" ? "銘柄チャートを見る" : `${child.count}銘柄 / ${LEVEL_LABEL[child.level] || ""}`;
      btn.appendChild(name);
      btn.appendChild(meta);
      btn.addEventListener("click", () => navigate(child.id));
      grid.appendChild(btn);
    }
  }

  function destroyCharts() {
    if (flowChart) { flowChart.destroy(); flowChart = null; }
    if (priceChart) { priceChart.destroy(); priceChart = null; }
  }

  function baseLineOptions() {
    return {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { color: cssVar("--gridline"), drawTicks: false },
          ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          border: { color: cssVar("--baseline") },
        },
        y: {
          grid: { color: cssVar("--gridline"), drawTicks: false },
          ticks: { color: cssVar("--text-muted") },
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
        },
      },
    };
  }

  function renderFlowChart(node, series) {
    const ctx = document.getElementById("flow-chart");
    document.getElementById("chart-title-flow").textContent = `資金流入指数: ${node.name}`;
    flowChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.map((r) => r.date),
        datasets: [{
          label: "資金流入指数",
          data: series.map((r) => r.flow),
          borderColor: cssVar("--series-1"),
          backgroundColor: cssVar("--series-1-wash"),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
        }],
      },
      options: baseLineOptions(),
    });
  }

  function renderPriceChart(node, series) {
    const card = document.getElementById("price-card");
    if (node.level !== "stock") {
      card.hidden = true;
      return;
    }
    const withClose = series.filter((r) => r.close !== undefined);
    if (withClose.length === 0) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const ctx = document.getElementById("price-chart");
    priceChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: withClose.map((r) => r.date),
        datasets: [{
          label: "株価(終値)",
          data: withClose.map((r) => r.close),
          borderColor: cssVar("--series-2"),
          backgroundColor: cssVar("--series-2-wash"),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
        }],
      },
      options: baseLineOptions(),
    });
  }

  async function render() {
    const node = tree.nodes[currentId];
    setBreadcrumb(node);
    renderChildren(node);

    let series = [];
    try {
      series = await fetchJson(`data/series/${sanitize(node.id)}.json`);
    } catch (e) {
      console.error(e);
    }

    destroyCharts();
    renderFlowChart(node, series);
    renderPriceChart(node, series);
  }

  function navigate(id) {
    if (!tree.nodes[id]) return;
    currentId = id;
    location.hash = encodeURIComponent(id);
    render();
  }

  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && tree.nodes[id]) {
      currentId = id;
      render();
    }
  });

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
    const hashId = decodeURIComponent(location.hash.slice(1));
    currentId = tree.nodes[hashId] ? hashId : tree.root;
    render();
  }

  init().catch((e) => {
    console.error(e);
    document.body.innerHTML = `<p style="padding:24px;color:#d03b3b;">データの読み込みに失敗しました。まだ初回データが生成されていない可能性があります。(${e.message})</p>`;
  });
})();
