#!/usr/bin/env python3
"""Collect free Hyperliquid market-structure snapshots for HYPE."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA_PATH = ROOT / "site" / "data" / "market-context.json"
API_URL = "https://api.hyperliquid.xyz/info"
SNAPSHOT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
FUNDING_RETENTION_MS = 180 * 24 * 60 * 60 * 1000


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def iso_time(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_data(path: Path = PUBLIC_DATA_PATH) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {"version": 1, "snapshots": [], "funding_history": []}


def write_data(payload: dict, path: Path = PUBLIC_DATA_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def api_post(payload: dict) -> object:
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "hype-lens-market-context/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Hyperliquid API returned HTTP {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to call Hyperliquid API: {exc}") from exc


def hype_asset_context(payload: object) -> dict:
    if not isinstance(payload, list) or len(payload) != 2:
        raise RuntimeError("Unexpected metaAndAssetCtxs response")
    metadata, contexts = payload
    universe = metadata.get("universe", []) if isinstance(metadata, dict) else []
    index = next((idx for idx, item in enumerate(universe) if item.get("name") == "HYPE"), None)
    if index is None or not isinstance(contexts, list) or index >= len(contexts):
        raise RuntimeError("HYPE asset context is unavailable")
    return contexts[index]


def number(value: object) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed else None
    except (TypeError, ValueError):
        return None


def order_book_summary(payload: object, depth: int = 10) -> dict:
    levels = payload.get("levels", []) if isinstance(payload, dict) else []
    bids = levels[0][:depth] if len(levels) > 0 and isinstance(levels[0], list) else []
    asks = levels[1][:depth] if len(levels) > 1 and isinstance(levels[1], list) else []

    def notional(items: list[dict]) -> float:
        return sum((number(item.get("px")) or 0) * (number(item.get("sz")) or 0) for item in items)

    bid_notional = notional(bids)
    ask_notional = notional(asks)
    total = bid_notional + ask_notional
    best_bid = number(bids[0].get("px")) if bids else None
    best_ask = number(asks[0].get("px")) if asks else None
    mid = (best_bid + best_ask) / 2 if best_bid and best_ask else None
    spread_bps = ((best_ask - best_bid) / mid) * 10_000 if mid and best_bid and best_ask else None
    return {
        "bid_notional_top10": round(bid_notional, 2),
        "ask_notional_top10": round(ask_notional, 2),
        "imbalance": round((bid_notional - ask_notional) / total, 6) if total else 0,
        "spread_bps": round(spread_bps, 4) if spread_bps is not None else None,
    }


def trade_flow_summary(payload: object) -> dict:
    trades = payload if isinstance(payload, list) else []
    buy_notional = 0.0
    sell_notional = 0.0
    latest_time = 0
    for trade in trades:
        if not isinstance(trade, dict):
            continue
        trade_notional = (number(trade.get("px")) or 0) * (number(trade.get("sz")) or 0)
        if trade.get("side") == "B":
            buy_notional += trade_notional
        else:
            sell_notional += trade_notional
        latest_time = max(latest_time, int(number(trade.get("time")) or 0))
    total = buy_notional + sell_notional
    return {
        "buy_notional": round(buy_notional, 2),
        "sell_notional": round(sell_notional, 2),
        "buy_share": round(buy_notional / total, 6) if total else None,
        "trade_count": len(trades),
        "latest_trade_time": latest_time or None,
    }


def build_snapshot(timestamp_ms: int, context: dict, book: object, trades: object) -> dict:
    impact = context.get("impactPxs") if isinstance(context.get("impactPxs"), list) else []
    return {
        "time": timestamp_ms,
        "mark_price": number(context.get("markPx")),
        "oracle_price": number(context.get("oraclePx")),
        "mid_price": number(context.get("midPx")),
        "open_interest": number(context.get("openInterest")),
        "funding": number(context.get("funding")),
        "premium": number(context.get("premium")),
        "day_notional_volume": number(context.get("dayNtlVlm")),
        "impact_bid": number(impact[0]) if len(impact) > 0 else None,
        "impact_ask": number(impact[1]) if len(impact) > 1 else None,
        "order_book": order_book_summary(book),
        "recent_flow": trade_flow_summary(trades),
    }


def normalize_funding(records: object) -> list[dict]:
    output = []
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict):
            continue
        timestamp = int(number(record.get("time")) or 0)
        rate = number(record.get("fundingRate"))
        if timestamp and rate is not None:
            output.append({"time": timestamp, "funding_rate": rate, "premium": number(record.get("premium"))})
    return output


def fetch_funding_history(start_time: int, end_time: int) -> list[dict]:
    """Page through the public endpoint so the initial archive can reach 180 days."""
    output: list[dict] = []
    cursor = start_time
    for _ in range(16):
        batch = normalize_funding(api_post({
            "type": "fundingHistory",
            "coin": "HYPE",
            "startTime": cursor,
            "endTime": end_time,
        }))
        if not batch:
            break
        output.extend(batch)
        next_cursor = int(batch[-1]["time"]) + 1
        if len(batch) < 500 or next_cursor <= cursor or next_cursor >= end_time:
            break
        cursor = next_cursor
    return output


def merge_by_time(existing: list[dict], incoming: list[dict], cutoff: int) -> list[dict]:
    merged = {int(item["time"]): item for item in existing if isinstance(item, dict) and int(item.get("time", 0)) >= cutoff}
    for item in incoming:
        if int(item.get("time", 0)) >= cutoff:
            merged[int(item["time"])] = item
    return [merged[key] for key in sorted(merged)]


def collect(path: Path = PUBLIC_DATA_PATH, timestamp_ms: int | None = None) -> dict:
    timestamp_ms = timestamp_ms or now_ms()
    bucket_time = timestamp_ms - (timestamp_ms % (15 * 60 * 1000))
    payload = load_data(path)
    context = hype_asset_context(api_post({"type": "metaAndAssetCtxs"}))
    book = api_post({"type": "l2Book", "coin": "HYPE"})
    trades = api_post({"type": "recentTrades", "coin": "HYPE"})
    funding_existing = payload.get("funding_history", [])
    funding_cutoff = timestamp_ms - FUNDING_RETENTION_MS
    oldest_funding = int(funding_existing[0].get("time", 0)) if funding_existing else 0
    funding_start = funding_cutoff if oldest_funding > funding_cutoff + 24 * 60 * 60 * 1000 else (
        int(funding_existing[-1].get("time", 0)) + 1 if funding_existing else funding_cutoff
    )
    funding = fetch_funding_history(funding_start, timestamp_ms)
    snapshot = build_snapshot(bucket_time, context, book, trades)
    payload.update({
        "version": 1,
        "generated_at": iso_time(timestamp_ms),
        "source": "Hyperliquid public info API",
        "snapshot_interval_minutes": 15,
        "snapshot_retention_days": 60,
        "funding_retention_days": 180,
        "snapshots": merge_by_time(payload.get("snapshots", []), [snapshot], timestamp_ms - SNAPSHOT_RETENTION_MS),
        "funding_history": merge_by_time(funding_existing, funding, funding_cutoff),
    })
    write_data(payload, path)
    return payload


def write_output(name: str, value: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with Path(output_path).open("a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def main() -> None:
    payload = collect()
    write_output("snapshots", str(len(payload["snapshots"])))
    write_output("funding_points", str(len(payload["funding_history"])))
    print(f"Stored {len(payload['snapshots'])} market snapshots and {len(payload['funding_history'])} funding points.")


if __name__ == "__main__":
    main()
