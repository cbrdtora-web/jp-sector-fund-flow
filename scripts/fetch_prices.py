"""
data/universe.csv に載っている全銘柄について、stooq.comから日次OHLCV(始値・高値・安値・
終値・出来高)を取得し、銘柄ごとに data/prices/{code}.csv として保存(または追記)する。

2つのモードがある。
  --mode backfill : 初回用。過去 BACKFILL_YEARS 年分をまとめて取得する(時間がかかる)。
  --mode update    : 通常の日次実行用。銘柄ごとに「保存済みの最終日の翌日」からのみ取得する。

stooqは短時間に大量アクセスするとブロックすることがあるため、REQUEST_INTERVAL_SECONDS で
間隔を空けてアクセスする。
"""
import argparse
import datetime as dt
import io
import os
import time

import pandas as pd
import requests

UNIVERSE_PATH = "data/universe.csv"
PRICES_DIR = "data/prices"

BACKFILL_YEARS = 14
REQUEST_INTERVAL_SECONDS = 1.0
MAX_RETRIES = 3

COLUMNS = ["Date", "Open", "High", "Low", "Close", "Volume"]


def stooq_url(code: str, d1: str | None = None, d2: str | None = None) -> str:
    url = f"https://stooq.com/q/d/l/?s={code}.jp&i=d"
    if d1:
        url += f"&d1={d1}"
    if d2:
        url += f"&d2={d2}"
    return url


def fetch_csv(url: str) -> pd.DataFrame | None:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            text = resp.text.strip()
            if not text or text.startswith("<"):
                return None
            df = pd.read_csv(io.StringIO(text))
            if "Date" not in df.columns:
                return None
            return df[COLUMNS]
        except requests.RequestException:
            if attempt == MAX_RETRIES:
                return None
            time.sleep(2 * attempt)
    return None


def existing_last_date(code: str) -> str | None:
    path = os.path.join(PRICES_DIR, f"{code}.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path)
    if df.empty:
        return None
    return str(df["Date"].max())


def save(code: str, new_df: pd.DataFrame) -> None:
    path = os.path.join(PRICES_DIR, f"{code}.csv")
    if os.path.exists(path):
        old_df = pd.read_csv(path)
        combined = pd.concat([old_df, new_df], ignore_index=True)
        combined = combined.drop_duplicates(subset="Date").sort_values("Date")
    else:
        combined = new_df.sort_values("Date")
    combined.to_csv(path, index=False, encoding="utf-8")


def run(mode: str) -> None:
    os.makedirs(PRICES_DIR, exist_ok=True)
    universe = pd.read_csv(UNIVERSE_PATH, dtype={"code": str})
    codes = universe["code"].tolist()

    today = dt.date.today()
    ok, empty, failed = 0, 0, 0

    for i, code in enumerate(codes, start=1):
        if mode == "backfill":
            d1 = (today - dt.timedelta(days=365 * BACKFILL_YEARS)).strftime("%Y%m%d")
            d2 = today.strftime("%Y%m%d")
        else:
            last = existing_last_date(code)
            if last is None:
                d1 = (today - dt.timedelta(days=365 * BACKFILL_YEARS)).strftime("%Y%m%d")
            else:
                last_date = dt.datetime.strptime(last, "%Y-%m-%d").date()
                if last_date >= today:
                    empty += 1
                    continue
                d1 = (last_date + dt.timedelta(days=1)).strftime("%Y%m%d")
            d2 = today.strftime("%Y%m%d")

        df = fetch_csv(stooq_url(code, d1, d2))
        if df is None or df.empty:
            empty += 1
        else:
            save(code, df)
            ok += 1

        if i % 50 == 0:
            print(f"進捗: {i}/{len(codes)} (成功 {ok} / データなし {empty} / 失敗 {failed})")

        time.sleep(REQUEST_INTERVAL_SECONDS)

    print(f"完了: 成功 {ok} / データなし {empty} / 失敗 {failed} (全 {len(codes)} 銘柄)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["backfill", "update"], default="update")
    args = parser.parse_args()
    run(args.mode)
