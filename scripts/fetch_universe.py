"""
JPX(日本取引所グループ)が無料公開している上場銘柄一覧(data_j.xls)をダウンロードし、
コード・銘柄名・市場区分・33業種区分だけを抜き出して data/universe.csv に保存する。

このスクリプトはこのリポジトリの唯一の「銘柄マスタの正」であり、GitHub Actions上で
毎日実行することで、新規上場・上場廃止・市場区分変更を自動的に反映する。

data_j.xls の実際のURLはJPXが不定期に変更する(パスの一部がランダムな文字列になっている)
ため、直リンクを固定で持たず、毎回 JPX_INDEX_PAGE から現在のリンクを探しに行く。
"""
import io
import re
import sys
from urllib.parse import urljoin

import pandas as pd
import requests

# 上場銘柄一覧(data_j.xls)へのリンクが載っているJPXの一覧ページ。
# data_j.xls自体の直リンクより変わりにくいため、ここを起点にリンクを探す。
JPX_INDEX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"

# 対象とする市場区分。プライム市場に絞ることでデータ量を現実的な範囲に保つ。
# 将来的に広げたい場合はここに "スタンダード（内国株式）" 等を追加する。
TARGET_MARKETS = {"プライム（内国株式）"}

OUTPUT_PATH = "data/universe.csv"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; jp-sector-fund-flow/1.0)"}


def find_data_j_xls_url() -> str:
    resp = requests.get(JPX_INDEX_PAGE, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    match = re.search(r'href="([^"]*data_j\.xls)"', resp.text, flags=re.IGNORECASE)
    if not match:
        raise SystemExit(
            f"{JPX_INDEX_PAGE} 内に data_j.xls へのリンクが見つかりませんでした。"
            "JPXのページ構成が変わった可能性があります。手動で確認してください。"
        )
    return urljoin(JPX_INDEX_PAGE, match.group(1))


def fetch_listed_issues() -> pd.DataFrame:
    url = find_data_j_xls_url()
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    df = pd.read_excel(io.BytesIO(resp.content))
    return df


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    # JPXファイルの列名は年によって多少揺れることがあるため、想定名で明示的にリネームする。
    rename_map = {
        "コード": "code",
        "銘柄名": "name",
        "市場・商品区分": "market",
        "33業種区分": "sector33",
        "17業種区分": "sector17_jpx",
    }
    missing = [c for c in rename_map if c not in df.columns]
    if missing:
        raise SystemExit(
            f"想定していた列が見つかりません: {missing}\n"
            f"実際の列: {list(df.columns)}\n"
            "JPXのファイル形式が変わった可能性があります。fetch_universe.py の rename_map を確認してください。"
        )
    df = df.rename(columns=rename_map)
    df = df[list(rename_map.values())]

    df["code"] = df["code"].astype(str).str.strip()
    # 普通株式のみ(数字4桁のコード)。ETF・REIT等の一部は除外。
    df = df[df["code"].str.match(r"^\d{4}$")]

    if TARGET_MARKETS:
        df = df[df["market"].isin(TARGET_MARKETS)]

    df = df.dropna(subset=["sector33"])
    df = df[df["sector33"] != "-"]

    return df.reset_index(drop=True)


def main() -> None:
    try:
        raw = fetch_listed_issues()
    except requests.RequestException as e:
        print(f"JPXからのダウンロードに失敗しました: {e}", file=sys.stderr)
        raise

    universe = normalize(raw)
    if universe.empty:
        raise SystemExit("銘柄が0件でした。フィルタ条件かJPXファイルの形式を確認してください。")

    universe.to_csv(OUTPUT_PATH, index=False, encoding="utf-8")
    print(f"{len(universe)} 銘柄を {OUTPUT_PATH} に保存しました。")


if __name__ == "__main__":
    main()
