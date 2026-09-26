"""
data/universe.csv (銘柄マスタ) に対して、
  - config/topix17_mapping.json (33業種 -> 17業種、公式)
  - config/subtheme_rules.json  (33業種の中のテーマ・サブテーマ、AIによる近似分類)
を適用し、各銘柄の完全な階層パスを付与して data/universe_classified.csv に保存する。

階層は最大で以下の4段だが、実際に使う段数は銘柄数のしきい値(MIN_GROUP_SIZE)で
自動的に調整される(該当銘柄が少ないテーマ・サブテーマは親階層に統合される)。

  sector17 -> sector33 -> theme -> subtheme -> (個別銘柄)
"""
import json
import re
import unicodedata

import pandas as pd

UNIVERSE_PATH = "data/universe.csv"
TOPIX17_MAP_PATH = "config/topix17_mapping.json"
SUBTHEME_RULES_PATH = "config/subtheme_rules.json"
OUTPUT_PATH = "data/universe_classified.csv"

# このしきい値未満の銘柄しか含まないtheme/subthemeは、集計時に親階層へ統合される。
MIN_GROUP_SIZE = 3

OTHER_LABEL = "その他"


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def classify_row(name: str, sector33: str, rules: dict) -> tuple[str, str]:
    sector_rules = rules.get(sector33)
    if not sector_rules:
        return "", ""

    # JPXの銘柄名は「ＮＴＴ」のように全角英字で書かれていることが多く、
    # 半角で書いたルールの正規表現がそのままでは一致しない。NFKC正規化で
    # 全角英数字・記号を半角に揃えてから照合する。
    normalized = unicodedata.normalize("NFKC", name)

    for theme_rule in sector_rules:
        theme_hit = re.search(theme_rule["match"], normalized, flags=re.IGNORECASE)
        subtheme_name = ""
        for sub_rule in theme_rule.get("subthemes", []):
            if re.search(sub_rule["match"], normalized, flags=re.IGNORECASE):
                subtheme_name = sub_rule["name"]
                break
        # サブテーマの語句(例:「キオクシア」「東京エレクトロン」)がテーマの
        # 正規表現自体には含まれていないこともあるため、どちらかが当たれば
        # そのテーマに属するとみなす。
        if theme_hit or subtheme_name:
            return theme_rule["theme"], subtheme_name

    return f"{OTHER_LABEL}({sector33})", ""


def collapse_small_groups(df: pd.DataFrame) -> pd.DataFrame:
    """theme, subtheme それぞれについて、件数がしきい値未満なら親階層に畳み込む。"""
    df = df.copy()

    # subtheme -> theme への畳み込み(先に細かい方から)
    sub_counts = df.groupby(["sector33", "theme", "subtheme"])["code"].transform("count")
    df.loc[(df["subtheme"] != "") & (sub_counts < MIN_GROUP_SIZE), "subtheme"] = ""

    # theme -> sector33直下 への畳み込み
    theme_counts = df.groupby(["sector33", "theme"])["code"].transform("count")
    small_theme = (df["theme"] != "") & (theme_counts < MIN_GROUP_SIZE)
    df.loc[small_theme, "subtheme"] = ""
    df.loc[small_theme, "theme"] = ""

    return df


def main() -> None:
    universe = pd.read_csv(UNIVERSE_PATH, dtype={"code": str})
    topix17_map = load_json(TOPIX17_MAP_PATH)
    subtheme_rules = load_json(SUBTHEME_RULES_PATH)
    subtheme_rules.pop("_comment", None)

    universe["sector17"] = universe["sector33"].map(topix17_map)
    unmapped = universe[universe["sector17"].isna()]["sector33"].unique()
    if len(unmapped) > 0:
        print(f"警告: 17業種にマッピングできない33業種があります: {list(unmapped)}")
        universe["sector17"] = universe["sector17"].fillna("未分類")

    classified = universe["name"].combine(
        universe["sector33"], lambda name, sector33: classify_row(name, sector33, subtheme_rules)
    )
    universe["theme"] = [t for t, _ in classified]
    universe["subtheme"] = [s for _, s in classified]

    universe = collapse_small_groups(universe)

    universe.to_csv(OUTPUT_PATH, index=False, encoding="utf-8")
    print(f"{len(universe)} 銘柄を分類し {OUTPUT_PATH} に保存しました。")


if __name__ == "__main__":
    main()
