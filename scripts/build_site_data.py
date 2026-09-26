"""
data/universe_classified.csv (銘柄と階層の対応) と data/mfi/{code}.csv (銘柄ごとの資金流入指数)
から、フロントエンド(docs/)が読み込む静的JSONファイル一式を生成する。

生成物:
  docs/data/tree.json          階層構造(ノードの親子関係、名前、銘柄数)
  docs/data/series/<node>.json 各ノードの時系列データ(日付・資金流入指数、銘柄ノードのみ株価も含む)
  docs/data/meta.json          最終更新日時など

集計の考え方:
  各銘柄の累積資金流入指数(cum_flow)を、その銘柄が属するグループ(17業種/33業種/
  テーマ/サブテーマ)ごとに日付をそろえて合計する。上場前の日付は0、データが
  欠けている日は直前値を引き継ぐ(forward fill)ものとして扱う。
"""
import json
import os

import pandas as pd

UNIVERSE_CLASSIFIED_PATH = "data/universe_classified.csv"
MFI_DIR = "data/mfi"
OUTPUT_DIR = "docs/data"
SERIES_DIR = os.path.join(OUTPUT_DIR, "series")


def sanitize(node_id: str) -> str:
    return node_id.replace(":", "__").replace("/", "_")


def node_id(level: str, *parts: str) -> str:
    return level + ":" + ":".join(parts)


def load_flows(codes: list[str]) -> pd.DataFrame:
    series_map = {}
    close_map = {}
    for code in codes:
        path = os.path.join(MFI_DIR, f"{code}.csv")
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path, parse_dates=["Date"]).set_index("Date")
        if df.empty:
            continue
        series_map[code] = df["cum_flow"]
        close_map[code] = df["Close"]

    if not series_map:
        return pd.DataFrame(), pd.DataFrame()

    flows = pd.concat(series_map, axis=1).sort_index()
    flows = flows.ffill().fillna(0.0)

    closes = pd.concat(close_map, axis=1).sort_index()
    return flows, closes


def series_to_records(dates: pd.DatetimeIndex, values: pd.Series) -> list[dict]:
    return [
        {"date": d.strftime("%Y-%m-%d"), "flow": round(float(v), 1)}
        for d, v in zip(dates, values)
    ]


def write_series(path_id: str, records: list[dict]) -> None:
    os.makedirs(SERIES_DIR, exist_ok=True)
    with open(os.path.join(SERIES_DIR, f"{sanitize(path_id)}.json"), "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, separators=(",", ":"))


def main() -> None:
    meta = pd.read_csv(UNIVERSE_CLASSIFIED_PATH, dtype={"code": str}).fillna("")
    all_codes = meta["code"].tolist()

    flows, closes = load_flows(all_codes)
    if flows.empty:
        raise SystemExit("資金流入データが1件もありません。compute_mfi.pyを先に実行してください。")
    dates = flows.index

    nodes: dict[str, dict] = {}
    root_id = "root"
    nodes[root_id] = {
        "id": root_id, "name": "全業種", "level": "root", "parent": None,
        "children": [], "count": len(all_codes),
    }

    def ensure_node(nid: str, name: str, level: str, parent_id: str) -> None:
        if nid not in nodes:
            nodes[nid] = {"id": nid, "name": name, "level": level, "parent": parent_id, "children": [], "count": 0}
            if nid not in nodes[parent_id]["children"]:
                nodes[parent_id]["children"].append(nid)

    # 1) sector17 層
    for sector17, g17 in meta.groupby("sector17"):
        id17 = node_id("17", sector17)
        ensure_node(id17, sector17, "sector17", root_id)
        nodes[id17]["count"] = len(g17)
        codes17 = [c for c in g17["code"] if c in flows.columns]
        write_series(id17, series_to_records(dates, flows[codes17].sum(axis=1)))

        # 2) sector33 層
        for sector33, g33 in g17.groupby("sector33"):
            id33 = node_id("33", sector33)
            ensure_node(id33, sector33, "sector33", id17)
            nodes[id33]["count"] = len(g33)
            codes33 = [c for c in g33["code"] if c in flows.columns]
            write_series(id33, series_to_records(dates, flows[codes33].sum(axis=1)))

            has_theme = g33["theme"] != ""
            # テーマなし銘柄は33業種の直接の子(=個別銘柄)にする
            for _, row in g33[~has_theme].iterrows():
                add_stock_node(nodes, dates, flows, closes, row, id33)

            # 3) theme 層
            for theme, gth in g33[has_theme].groupby("theme"):
                idth = node_id("theme", sector33, theme)
                ensure_node(idth, theme, "theme", id33)
                nodes[idth]["count"] = len(gth)
                codesth = [c for c in gth["code"] if c in flows.columns]
                write_series(idth, series_to_records(dates, flows[codesth].sum(axis=1)))

                has_sub = gth["subtheme"] != ""
                for _, row in gth[~has_sub].iterrows():
                    add_stock_node(nodes, dates, flows, closes, row, idth)

                # 4) subtheme 層
                for subtheme, gsub in gth[has_sub].groupby("subtheme"):
                    idsub = node_id("subtheme", sector33, theme, subtheme)
                    ensure_node(idsub, subtheme, "subtheme", idth)
                    nodes[idsub]["count"] = len(gsub)
                    codessub = [c for c in gsub["code"] if c in flows.columns]
                    write_series(idsub, series_to_records(dates, flows[codessub].sum(axis=1)))

                    for _, row in gsub.iterrows():
                        add_stock_node(nodes, dates, flows, closes, row, idsub)

    available_codes = [c for c in all_codes if c in flows.columns]
    write_series(root_id, series_to_records(dates, flows[available_codes].sum(axis=1)))

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, "tree.json"), "w", encoding="utf-8") as f:
        json.dump({"root": root_id, "nodes": nodes}, f, ensure_ascii=False, separators=(",", ":"))

    with open(os.path.join(OUTPUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "generated_at": pd.Timestamp.now("UTC").isoformat(),
                "stock_count": len(all_codes),
                "date_range": [dates[0].strftime("%Y-%m-%d"), dates[-1].strftime("%Y-%m-%d")],
            },
            f, ensure_ascii=False,
        )

    print(f"サイト用データを生成しました: ノード数 {len(nodes)}, 銘柄数 {len(all_codes)}")


def add_stock_node(nodes: dict, dates, flows: pd.DataFrame, closes: pd.DataFrame, row: pd.Series, parent_id: str) -> None:
    code = row["code"]
    if code in nodes:
        return
    nodes[code] = {
        "id": code, "name": f"{row['name']}({code})", "level": "stock",
        "parent": parent_id, "children": [], "count": 1,
    }
    nodes[parent_id]["children"].append(code)

    if code not in flows.columns:
        return
    records = []
    close_col = closes[code] if code in closes.columns else None
    for d, flow_val in zip(dates, flows[code]):
        rec = {"date": d.strftime("%Y-%m-%d"), "flow": round(float(flow_val), 1)}
        if close_col is not None:
            close_val = close_col.get(d)
            if pd.notna(close_val):
                rec["close"] = round(float(close_val), 2)
        records.append(rec)
    write_series(code, records)


if __name__ == "__main__":
    main()
