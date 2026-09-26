"""
data/universe.csv に載っている全銘柄について、stooq.comから日次OHLCV(始値・高値・安値・
終値・出来高)を取得し、銘柄ごとに data/prices/{code}.csv として保存(または追記)する。

銘柄ごとに「保存済みの最終日の翌日」から取得するため、常に再開可能(resumable)。
初回実行でファイルが無い銘柄は過去 BACKFILL_YEARS 年分をまとめて取得する。
--mode は完了時のログ表示のためだけの区別で、取得ロジック自体は同じ。

stooqは短時間に大量アクセスするとブロック/遅延することがあるため、
REQUEST_INTERVAL_SECONDS で間隔を空け、REQUEST_TIMEOUT_SECONDS で
1件あたりの待ち時間の上限を短めに切って先に進めるようにしている。

GIT_CHECKPOINT_COMMIT=1 が設定されている場合(GitHub Actions上でのみ想定)、
CHECKPOINT_INTERVAL銘柄ごとに取得済み分をコミット・pushする。銘柄数が多い
初回バックフィルが途中で失敗・タイムアウトしても、次回実行時に続きから
再開できるようにするための保険。
"""
import argparse
import datetime as dt
import io
import os
import subprocess
import time

import pandas as pd
import requests

UNIVERSE_PATH = "data/universe.csv"
PRICES_DIR = "data/prices"

BACKFILL_YEARS = 14
REQUEST_INTERVAL_SECONDS = 0.5
REQUEST_TIMEOUT_SECONDS = 10
MAX_RETRIES = 2
CHECKPOINT_INTERVAL = 100

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
            resp = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS)
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
            d1 = (today - dt.timedelta(days=365 * BACKFILL_YEARS)).strftime("%Y%m%d")
        else:
            last_date = dt.datetime.strptime(last, "%Y-%m-%d").date()
            if last_date >= today:
                up_to_date += 1
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
