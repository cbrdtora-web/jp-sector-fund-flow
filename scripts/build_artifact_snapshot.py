"""
docs/data/ (GitHub Pages用に生成済みの全銘柄データ) から、Claude Artifact用の
軽量スナップショットを artifact/ 以下に生成する。

Artifactには容量制限があるため、個別銘柄(約3500銘柄分の生データ)は含めず、
root/17業種/33業種/テーマ/サブテーマの集計データのみを含める。個別銘柄の
チャートはGitHub Pages版(docs/)へのリンクで案内する。

生成物:
  artifact/index.html       Artifactとして公開するページ本体(CSS/JSをインライン化)
  artifact/data/tree.json   階層構造(集計ノードのみ)
  artifact/data/meta.json   最終更新日時など(docs/data/meta.jsonをそのままコピー)
  artifact/data/series/*.json  各集計ノードの時系列データ

このスクリプトは docs/ のデータが最新であることを前提とする
(GitHub Actionsの daily-update.yml 実行後に呼び出すことを想定)。
実際にArtifactとして公開(更新)するには、このスクリプト実行後に
Artifactツールで file_path=artifact/index.html, files=artifact/data配下,
url=(既存のArtifact URL) を指定して再publishする。
"""
import json
import os
import shutil

DOCS_DATA = "docs/data"
OUT_DIR = "artifact"
OUT_DATA = os.path.join(OUT_DIR, "data")

KEEP_LEVELS = {"root", "sector17", "sector33", "theme", "subtheme"}
# 銘柄一覧(コード→TradingViewリンク)の表示用に、銘柄ノード自体はtree.jsonに残す。
# 時系列(series)は容量制限のため集計ノード(KEEP_LEVELS)のみ含める。
TREE_LEVELS = KEEP_LEVELS | {"stock"}

SITE_URL = "https://cbrdtora-web.github.io/jp-sector-fund-flow/"


def sanitize(node_id: str) -> str:
    return node_id.replace(":", "__").replace("/", "_")


def build_data() -> None:
    if os.path.exists(OUT_DATA):
        shutil.rmtree(OUT_DATA)
    os.makedirs(os.path.join(OUT_DATA, "series"))

    tree = json.load(open(os.path.join(DOCS_DATA, "tree.json"), encoding="utf-8"))
    nodes = tree["nodes"]

    new_nodes = {}
    for nid, n in nodes.items():
        if n["level"] not in TREE_LEVELS:
            continue
        n2 = dict(n)
        n2["children"] = [c for c in n["children"] if nodes.get(c, {}).get("level") in TREE_LEVELS]
        new_nodes[nid] = n2

    copied, missing = 0, 0
    for nid, n in new_nodes.items():
        if n["level"] not in KEEP_LEVELS:
            continue
        fname = sanitize(nid) + ".json"
        src = os.path.join(DOCS_DATA, "series", fname)
        dst = os.path.join(OUT_DATA, "series", fname)
        if not os.path.exists(src):
            missing += 1
            continue
        shutil.copy(src, dst)
        copied += 1

    with open(os.path.join(OUT_DATA, "tree.json"), "w", encoding="utf-8") as f:
        json.dump({"root": tree["root"], "nodes": new_nodes}, f, ensure_ascii=False, separators=(",", ":"))

    shutil.copy(os.path.join(DOCS_DATA, "meta.json"), os.path.join(OUT_DATA, "meta.json"))

    print(f"artifact snapshot: nodes={len(new_nodes)} series_copied={copied} missing={missing}")


def build_html() -> None:
    css = open(os.path.join(OUT_DIR, "style.css"), encoding="utf-8").read()
    js = open(os.path.join(OUT_DIR, "app.js"), encoding="utf-8").read()

    html = f"""<title>資金フローマップ</title>
<style>
{css}
</style>
<body class="viz-root">
  <header class="page-header">
    <h1>日本株 業種別資金流入マップ</h1>
    <p class="subtitle">
      東証上場の国内普通株式(プライム・スタンダード・グロース、REIT/ETFを除く)の株価・出来高から算出した「資金流入指数」(MFIベースの推定指標)を、33業種→テーマ→サブテーマまでクリックでたどれます。
    </p>
    <p class="disclaimer">
      ※実際の売買代金データではなく、値動きと出来高から資金の勢いを推定した代用指標です。投資助言ではありません。毎日自動更新されます。最終更新: <span id="last-updated">--</span>
    </p>
  </header>

  <nav id="breadcrumb" class="breadcrumb" aria-label="パンくずリスト"></nav>

  <div id="toolbar" class="toolbar">
    <div id="period-control" class="period-control" role="group" aria-label="表示期間"></div>
  </div>

  <main id="chart-area"></main>

  <footer class="page-footer">
    <p>データソース: Yahoo!ファイナンス(株価) / 日本取引所グループ(業種分類)。<br>
    個別銘柄の資金流入・株価チャートは <a href="{SITE_URL}" target="_blank" rel="noopener">フル機能版サイト</a> でご覧いただけます。</p>
  </footer>

  <script src="chart.umd.js"></script>
  <script src="hammer.min.js"></script>
  <script src="chartjs-plugin-zoom.min.js"></script>
  <script>
{js}
  </script>
</body>
"""
    with open(os.path.join(OUT_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"artifact/index.html generated ({len(html)/1024:.1f} KB)")


def main() -> None:
    build_data()
    build_html()


if __name__ == "__main__":
    main()
