"""
data/universe.csv に載っている全銘柄について、Yahoo!ファイナンスの非公式チャートAPIから
日次OHLCV(始値・高値・安値・終値・出来高)を取得し、銘柄ごとに data/prices/{code}.csv
として保存(または追記)する。

(補足: 当初はstooq.comを使う設計だったが、GitHub Actionsのランナー(データセンターの
固定IPレンジ)からのアクセスが極端に遅い/タイムアウトする問題が判明したため、
Yahoo!ファイナンスのチャートAPIに切り替えた。)

銘柄ごとに「保存済みの最終日の翌日」から取得するため、常に再開可能(resumable)。
初回実行でファイルが無い銘柄は過去 BACKFILL_YEARS 年分をまとめて取得する。
--mode は完了時のログ表示のためだけの区別で、取得ロジック自体は同じ。

GIT_CHECKPOINT_COMMIT=1 が設定されている場合(GitHub Actions上でのみ想定)、
CHECKPOINT_INTERVAL銘柄ごとに取得済み分をコミット・pushする。銘柄数が多い
初回バックフィルが途中で失敗・タイムアウトしても、次回実行時に続きから
再開できるようにするための保険。
"""
import argparse
import datetime as dt
import os
import subprocess
import time

import pandas as pd
import requests

UNIVERSE_PATH = "data/universe.csv"
PRICES_DIR = "data/prices"

BACKFILL_YEARS = 14
REQUEST_INTERVAL_SECONDS = 0.3
REQUEST_TIMEOUT_SECONDS = 15
MAX_RETRIES = 2
CHECKPOINT_INTERVAL = 100

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}


def yahoo_chart_url(code: str) -> str:
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.T"


def fetch_yahoo(code: str, period1: int, period2: int) -> pd.DataFrame | None:
    params = {"period1": period1, "period2": period2, "interval": "1d", "events": "history"}
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(
                yahoo_chart_url(code), params=params, headers=HEADERS, timeout=REQUEST_TIMEOUT_SECONDS
            )
            if resp.status_code == 404:
                return None  # 上場廃止・コード不正など
            resp.raise_for_status()
            data = resp.json()
            result = (data.get("chart") or {}).get("result")
            if not result:
                return None
            result = result[0]
            timestamps = result.get("timestamp")
            if not timestamps:
                return None
            quote = result["indicators"]["quote"][0]
            df = pd.DataFrame({
                "Date": pd.to_datetime(timestamps, unit="s", utc=True)
                    .tz_convert("Asia/Tokyo").strftime("%Y-%m-%d"),
                "Open": quote.get("open"),
                "High": quote.get("high"),
                "Low": quote.get("low"),
                "Close": quote.get("close"),
                "Volume": quote.get("volume"),
            })
            df = df.dropna(subset=["Close"]).reset_index(drop=True)
            return df
        except (requests.RequestException, ValueError, KeyError):
            if attempt == MAX_RETRIES:
                return None
            time.sleep(1.5 * attempt)
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


def checkpoint_commit(progress_note: str) -> None:
    if os.environ.get("GIT_CHECKPOINT_COMMIT") != "1":
        return
    subprocess.run(["git", "add", "data/universe.csv", "data/prices"], check=False)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if diff.returncode == 0:
        return  # 変更なし
    subprocess.run(["git", "commit", "-m", f"途中経過を保存: {progress_note}"], check=False)
    subprocess.run(["git", "push"], check=False)


def to_unix(d: dt.date) -> int:
    return int(dt.datetime.combine(d, dt.time.min, tzinfo=dt.timezone.utc).timestamp())


def run(mode: str, limit: int | None = None) -> None:
    os.makedirs(PRICES_DIR, exist_ok=True)
    universe = pd.read_csv(UNIVERSE_PATH, dtype={"code": str})
    codes = universe["code"].tolist()
    if limit:
        codes = codes[:limit]

    today = dt.date.today()
    ok, up_to_date, empty = 0, 0, 0
    start_time = time.monotonic()

    for i, code in enumerate(codes, start=1):
        last = existing_last_date(code)
        if last is None:
            start_date = today - dt.timedelta(days=365 * BACKFILL_YEARS)
        else:
            last_date = dt.datetime.strptime(last, "%Y-%m-%d").date()
            if last_date >= today:
                up_to_date += 1
                continue
            start_date = last_date + dt.timedelta(days=1)

        df = fetch_yahoo(code, to_unix(start_date), to_unix(today + dt.timedelta(days=1)))
        if df is None or df.empty:
            empty += 1
        else:
            save(code, df)
            ok += 1

        if i % 50 == 0:
            elapsed = time.monotonic() - start_time
            print(
                f"進捗({mode}): {i}/{len(codes)} (取得 {ok} / 更新済み {up_to_date} / データなし {empty}) "
                f"経過{elapsed:.0f}秒 (1件あたり平均{elapsed / i:.2f}秒)",
                flush=True,
            )

        if i % CHECKPOINT_INTERVAL == 0:
            checkpoint_commit(f"{i}/{len(codes)} 銘柄処理済み")

        time.sleep(REQUEST_INTERVAL_SECONDS)

    checkpoint_commit(f"{len(codes)}/{len(codes)} 銘柄処理済み(完了)")
    print(f"完了({mode}): 取得 {ok} / 更新済み {up_to_date} / データなし {empty} (全 {len(codes)} 銘柄)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["backfill", "update"], default="update")
    parser.add_argument("--limit", type=int, default=None, help="動作確認用に先頭N銘柄だけ処理する")
    args = parser.parse_args()
    run(args.mode, limit=args.limit)
