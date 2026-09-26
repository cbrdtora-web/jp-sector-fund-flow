"""
data/prices/{code}.csv (銘柄ごとの日次OHLCV) から、銘柄ごとの「資金流入指数」を計算する。

計算方法:
  1. 代表値(Typical Price) TP = (高値 + 安値 + 終値) / 3
  2. 生の売買代金 RMF = TP * 出来高
  3. 値上がり日は +RMF、値下がり日は -RMF とみなす(符号付き売買代金)
  4. それを日付順に累積合計したものを「資金流入指数」とする(ゼロ地点は算出開始日)

  これは実際の投資家の売買金額そのものではなく、値動きと出来高から資金の勢いを
  推定する代用指標(オンバランスボリュームに近い考え方)である。

  併せて、短期の勢いを見るための一般的なテクニカル指標である14日MFI(0-100)も
  参考値として計算する。

出力: data/mfi/{code}.csv (Date, Close, cum_flow, mfi14)
"""
import os

import numpy as np
import pandas as pd

UNIVERSE_PATH = "data/universe.csv"
PRICES_DIR = "data/prices"
OUTPUT_DIR = "data/mfi"

MFI_WINDOW = 14


def compute_for_stock(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("Date").reset_index(drop=True)
    df["TP"] = (df["High"] + df["Low"] + df["Close"]) / 3
    df["RMF"] = df["TP"] * df["Volume"]

    tp_diff = df["TP"].diff()
    direction = np.sign(tp_diff).fillna(0)
    df["signed_flow"] = df["RMF"] * direction
    df["cum_flow"] = df["signed_flow"].cumsum()

    pos_flow = df["RMF"].where(direction > 0, 0.0)
    neg_flow = df["RMF"].where(direction < 0, 0.0)
    pos_sum = pos_flow.rolling(MFI_WINDOW, min_periods=1).sum()
    neg_sum = neg_flow.rolling(MFI_WINDOW, min_periods=1).sum()
    money_ratio = pos_sum / neg_sum.replace(0, np.nan)
    df["mfi14"] = 100 - (100 / (1 + money_ratio))
    df["mfi14"] = df["mfi14"].fillna(50.0)

    return df[["Date", "Close", "cum_flow", "mfi14"]]


def main() -> None:
    universe = pd.read_csv(UNIVERSE_PATH, dtype={"code": str})
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    ok, skipped = 0, 0
    for code in universe["code"]:
        src = os.path.join(PRICES_DIR, f"{code}.csv")
        if not os.path.exists(src):
            skipped += 1
            continue
        raw = pd.read_csv(src)
        if raw.empty or len(raw) < 2:
            skipped += 1
            continue
        result = compute_for_stock(raw)
        result.to_csv(os.path.join(OUTPUT_DIR, f"{code}.csv"), index=False, encoding="utf-8")
        ok += 1

    print(f"MFI計算完了: {ok} 銘柄 (データ不足でスキップ {skipped} 銘柄)")


if __name__ == "__main__":
    main()
