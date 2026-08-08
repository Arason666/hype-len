#!/usr/bin/env python3
"""Evaluate HYPE relative-strength signals using only the Python standard library."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo


API_URL = "https://api.hyperliquid.xyz/info"
PERIODS = {
    "15m": (15 * 60, 140),
    "1h": (60 * 60, 80),
    "4h": (4 * 60 * 60, 60),
    "1d": (24 * 60 * 60, 45),
}


@dataclass(frozen=True)
class Trend:
    kind: str
    arrow: str
    label: str


def post_json(url: str, payload: dict, timeout: int = 20) -> object:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "hype-lens-monitor/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_candles(coin: str, interval: str, bars: int) -> list[dict]:
    seconds = PERIODS[interval][0]
    now_ms = int(time.time() * 1000)
    payload = {
        "type": "candleSnapshot",
        "req": {
            "coin": coin,
            "interval": interval,
            "startTime": now_ms - bars * seconds * 1000,
            "endTime": now_ms,
        },
    }
    error: Exception | None = None
    for attempt in range(3):
        try:
            result = post_json(API_URL, payload)
            if not isinstance(result, list):
                raise RuntimeError(f"Unexpected API response for {coin} {interval}")
            return [
                {"t": int(item["t"]), "T": int(item["T"]), "close": float(item["c"])}
                for item in result
                if int(item["T"]) < now_ms - 3_000
            ]
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, KeyError) as exc:
            error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Unable to fetch {coin} {interval}: {error}")


def align_ratios(eth: list[dict], btc: list[dict], hype: list[dict]) -> list[dict]:
    eth_by_time = {row["t"]: row["close"] for row in eth}
    btc_by_time = {row["t"]: row["close"] for row in btc}
    rows = []
    for row in hype:
        timestamp = row["t"]
        hype_close = row["close"]
        if timestamp in eth_by_time and timestamp in btc_by_time and hype_close > 0:
            rows.append(
                {
                    "t": timestamp,
                    "eth": eth_by_time[timestamp] / hype_close,
                    "btc": btc_by_time[timestamp] / hype_close,
                }
            )
    return sorted(rows, key=lambda item: item["t"])


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append(value * alpha + output[-1] * (1 - alpha))
    return output


def trend_for(values: list[float]) -> Trend:
    if len(values) < 21:
        return Trend("neutral", "→", "数据不足")
    fast = ema(values, 8)[-1]
    slow = ema(values, 21)[-1]
    distance = (fast - slow) / slow
    if abs(distance) < 0.001:
        return Trend("neutral", "→", "震荡")
    if distance < 0:
        return Trend("strong", "↓", "HYPE强")
    return Trend("weak", "↑", "HYPE弱")


def latest_cross(values: list[float]) -> str | None:
    if len(values) < 23:
        return None
    fast = ema(values, 8)
    slow = ema(values, 21)
    previous = fast[-2] - slow[-2]
    current = fast[-1] - slow[-1]
    if previous >= 0 > current:
        return "strong"
    if previous <= 0 < current:
        return "weak"
    return None


def percent_change(values: list[float], bars: int) -> float | None:
    if len(values) <= bars:
        return None
    return (values[-1] / values[-(bars + 1)] - 1) * 100


def format_percent(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value:+.2f}%"


def build_snapshot() -> tuple[dict, list[str]]:
    matrix: dict[str, dict[str, Trend]] = {"eth": {}, "btc": {}}
    crosses: list[str] = []
    period_rows: dict[str, list[dict]] = {}

    for period, (_, bars) in PERIODS.items():
        eth = fetch_candles("ETH", period, bars)
        btc = fetch_candles("BTC", period, bars)
        hype = fetch_candles("HYPE", period, bars)
        rows = align_ratios(eth, btc, hype)
        if len(rows) < 23:
            raise RuntimeError(f"Not enough aligned {period} candles")
        period_rows[period] = rows
        for key, pair_name in (("eth", "ETH/HYPE"), ("btc", "BTC/HYPE")):
            values = [row[key] for row in rows]
            matrix[key][period] = trend_for(values)
            cross = latest_cross(values)
            if cross == "strong":
                crosses.append(f"{pair_name} {period} EMA下穿，HYPE相对走强")
            elif cross == "weak":
                crosses.append(f"{pair_name} {period} EMA上穿，HYPE相对走弱")

    rows_15m = period_rows["15m"]
    eth_values = [row["eth"] for row in rows_15m]
    btc_values = [row["btc"] for row in rows_15m]
    if len(eth_values) > 97 and len(btc_values) > 97:
        if eth_values[-1] < min(eth_values[-97:-1]) and btc_values[-1] < min(btc_values[-97:-1]):
            crosses.append("两组比值同时跌破24小时低点，HYPE出现相对强势突破")
        elif eth_values[-1] > max(eth_values[-97:-1]) and btc_values[-1] > max(btc_values[-97:-1]):
            crosses.append("两组比值同时突破24小时高点，HYPE出现相对弱势突破")

    snapshot = {
        "matrix": matrix,
        "eth_24h": percent_change(eth_values, 96),
        "btc_24h": percent_change(btc_values, 96),
        "last_timestamp": rows_15m[-1]["t"],
    }
    return snapshot, crosses


def build_message(snapshot: dict, triggers: list[str], forced: bool) -> str:
    matrix: dict = snapshot["matrix"]
    strong_count = sum(
        matrix[key][period].kind == "strong" for key in ("eth", "btc") for period in PERIODS
    )
    weak_count = sum(
        matrix[key][period].kind == "weak" for key in ("eth", "btc") for period in PERIODS
    )
    if strong_count >= 6:
        headline = "🟢 HYPE 相对强势信号"
    elif weak_count >= 6:
        headline = "🟠 HYPE 相对弱势信号"
    else:
        headline = "📊 HYPE 趋势变化提醒"

    lines = [headline, ""]
    if forced and not triggers:
        lines.extend(["触发原因：手动测试告警", ""])
    else:
        lines.append("触发原因：")
        lines.extend(f"• {trigger}" for trigger in triggers)
        lines.append("")
    lines.extend(
        [
            f"24小时：ETH/HYPE {format_percent(snapshot['eth_24h'])} ｜ BTC/HYPE {format_percent(snapshot['btc_24h'])}",
            "",
            "多周期状态：",
        ]
    )
    for period in PERIODS:
        eth_trend = matrix["eth"][period]
        btc_trend = matrix["btc"][period]
        lines.append(f"{period:>3}  ETH {eth_trend.arrow}  BTC {btc_trend.arrow}")

    event_time = datetime.fromtimestamp(snapshot["last_timestamp"] / 1000, ZoneInfo("Asia/Shanghai"))
    lines.extend(["", f"K线时间：{event_time:%Y-%m-%d %H:%M} CST", f"共振：强 {strong_count}/8 ｜ 弱 {weak_count}/8"])
    dashboard_url = os.environ.get("DASHBOARD_URL", "").strip()
    if dashboard_url:
        lines.extend(["", f"查看详情：{dashboard_url}"])
    lines.extend(["", "仅供趋势观察，不构成投资建议。"])
    return "\n".join(lines)


def send_feishu(webhook: str, message: str) -> None:
    payload = {"msg_type": "text", "content": {"text": message}}
    result = post_json(webhook, payload)
    if isinstance(result, dict) and result.get("code", result.get("StatusCode", 0)) not in (0, None):
        raise RuntimeError(f"Feishu rejected the message: {result}")


def send_telegram(token: str, chat_id: str, message: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": message, "disable_web_page_preview": "true"}).encode()
    request = urllib.request.Request(url, data=data, method="POST", headers={"User-Agent": "hype-lens-monitor/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not result.get("ok"):
        raise RuntimeError(f"Telegram rejected the message: {result}")


def main() -> int:
    snapshot, triggers = build_snapshot()
    forced = os.environ.get("FORCE_ALERT") == "1"
    matrix = snapshot["matrix"]
    summary = " | ".join(
        f"{period}:ETH{matrix['eth'][period].arrow}/BTC{matrix['btc'][period].arrow}" for period in PERIODS
    )
    print(f"Trend matrix: {summary}")

    if not triggers and not forced:
        print("No new closed-candle signal; no alert sent.")
        return 0

    message = build_message(snapshot, triggers, forced)
    channels = 0
    feishu = os.environ.get("FEISHU_WEBHOOK", "").strip()
    if feishu:
        send_feishu(feishu, message)
        channels += 1
        print("Alert sent to Feishu.")

    telegram_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    telegram_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if telegram_token and telegram_chat_id:
        send_telegram(telegram_token, telegram_chat_id, message)
        channels += 1
        print("Alert sent to Telegram.")

    if not channels:
        print("Signal detected, but no alert channel is configured.")
        print(message)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # Surface failures in the GitHub Actions log.
        print(f"Monitor failed: {exc}", file=sys.stderr)
        sys.exit(1)
