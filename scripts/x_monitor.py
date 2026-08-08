#!/usr/bin/env python3
"""Fetch curated HYPE posts from X with strict daily read and cost guards."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "data" / "x-monitor-state.json"
PUBLIC_DATA_PATH = ROOT / "site" / "data" / "x-posts.json"
X_API_BASE = "https://api.x.com/2"
BEIJING = ZoneInfo("Asia/Shanghai")

POST_READ_COST_MICROS = 5_000
USER_READ_COST_MICROS = 10_000
DEFAULT_DAILY_COST_LIMIT_MICROS = 150_000
DEFAULT_DAILY_POST_LIMIT = 20
TIMELINE_PAGE_SIZE = 5  # X requires at least five results for this endpoint.
MAX_RETAINED_POSTS = 300

SOURCES = [
    {"handle": "0xMaxs", "name": "0xMaxs", "role": "交易观点", "influence": 72},
    {"handle": "louisdives", "name": "Louis", "role": "研究 / 数据", "influence": 78},
    {"handle": "HyperliquidX", "name": "Hyperliquid", "role": "官方动态", "influence": 90},
    {"handle": "Hyperliquid_Hub", "name": "HL Hub", "role": "生态资讯", "influence": 64},
    {"handle": "HYPEconomist", "name": "HYPEconomist", "role": "市场观察", "influence": 60},
]

BULLISH_TERMS = [
    "bullish", "accumulate", "accumulation", "long $hype", "buy $hype", "breakout",
    "undervalued", "adoption", "growth", "record revenue", "new high", "all-time high",
    "ath", "buyback", "burn", "看多", "做多", "买入", "加仓", "积累", "突破", "低估",
    "收入新高", "历史新高", "回购", "销毁",
]
BEARISH_TERMS = [
    "bearish", "short $hype", "sell $hype", "breakdown", "overvalued", "unlock",
    "exploit", "hacked", "outage", "outflow", "weakness", "dump", "liquidation risk",
    "看空", "做空", "卖出", "减仓", "跌破", "高估", "解锁", "漏洞", "被盗", "宕机",
    "资金流出", "弱势", "砸盘", "清算风险",
]

EVENT_RULES = [
    {
        "label": "安全 / 运行事件",
        "terms": ["exploit", "hack", "hacked", "vulnerability", "outage", "downtime", "incident", "漏洞", "攻击", "被盗", "宕机", "故障"],
        "impact_boost": 16,
        "horizon": "数小时至 7 天",
    },
    {
        "label": "监管 / 上市事件",
        "terms": ["etf", "sec", "regulation", "regulatory", "listing", "delist", "approval", "监管", "合规", "上币", "下架", "批准"],
        "impact_boost": 14,
        "horizon": "1 天至数周",
    },
    {
        "label": "基本面 / 生态事件",
        "terms": ["revenue", "fees", "volume", "buyback", "burn", "hip-", "adoption", "integration", "users", "open interest", "收入", "手续费", "交易量", "回购", "销毁", "采用", "集成", "用户增长", "持仓量"],
        "impact_boost": 10,
        "horizon": "数日至数月",
    },
    {
        "label": "技术面 / 仓位观点",
        "terms": ["breakout", "breakdown", "support", "resistance", "chart", "rsi", "funding", "liquidation", "target", "突破", "跌破", "支撑", "阻力", "技术面", "资金费率", "清算", "目标位"],
        "impact_boost": 4,
        "horizon": "数小时至 3 天",
    },
]


def default_state(day: str) -> dict:
    return {
        "version": 1,
        "day": day,
        "user_ids": {},
        "since_ids": {},
        "source_cursor": 0,
        "usage": {"post_reads": 0, "user_reads": 0, "analyses": 0, "estimated_cost_micros": 0},
    }


def load_json(path: Path, default: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def cost_limit_micros() -> int:
    raw = os.environ.get("X_DAILY_COST_LIMIT_USD", "0.15")
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError("X_DAILY_COST_LIMIT_USD must be numeric") from exc
    micros = int(round(value * 1_000_000))
    if micros <= 0 or micros > DEFAULT_DAILY_COST_LIMIT_MICROS:
        raise RuntimeError("Daily X cost limit must be greater than zero and no more than $0.15")
    return micros


def post_limit() -> int:
    raw = os.environ.get("X_DAILY_POST_LIMIT", "20")
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError("X_DAILY_POST_LIMIT must be an integer") from exc
    if value <= 0 or value > DEFAULT_DAILY_POST_LIMIT:
        raise RuntimeError("Daily X post limit must be between 1 and 20")
    return value


def normalize_state(state: dict, day: str) -> tuple[dict, bool]:
    changed = False
    state.setdefault("version", 1)
    state.setdefault("user_ids", {})
    state.setdefault("since_ids", {})
    state.setdefault("source_cursor", 0)
    if state.get("day") != day:
        state["day"] = day
        state["usage"] = {"post_reads": 0, "user_reads": 0, "analyses": 0, "estimated_cost_micros": 0}
        changed = True
    usage = state.setdefault("usage", {})
    for key in ("post_reads", "user_reads", "analyses", "estimated_cost_micros"):
        usage.setdefault(key, 0)
    return state, changed


def api_get(path: str, bearer_token: str, params: dict | None = None) -> dict:
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    request = urllib.request.Request(
        f"{X_API_BASE}{path}{query}",
        headers={"Authorization": f"Bearer {bearer_token}", "User-Agent": "hype-lens-x-monitor/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"X API returned HTTP {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to call X API: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("X API returned an unexpected response")
    return payload


def count_terms(text: str, terms: list[str]) -> int:
    lowered = text.lower()
    return sum(lowered.count(term.lower()) for term in terms)


def analyze_text(text: str, influence: int) -> dict:
    bullish = count_terms(text, BULLISH_TERMS)
    bearish = count_terms(text, BEARISH_TERMS)
    raw_direction = bullish - bearish
    if raw_direction > 0:
        direction, direction_label = "bullish", "偏多"
    elif raw_direction < 0:
        direction, direction_label = "bearish", "偏空"
    else:
        direction, direction_label = "neutral", "中性 / 信息型"

    matches = []
    for rule in EVENT_RULES:
        match_count = count_terms(text, rule["terms"])
        if match_count:
            matches.append((match_count + rule["impact_boost"] / 20, match_count, rule))
    if matches:
        _, event_matches, event = max(matches, key=lambda item: item[0])
    else:
        event_matches = 0
        event = {"label": "一般市场观点", "impact_boost": 0, "horizon": "数小时至 3 天"}

    evidence_count = bullish + bearish
    if direction == "neutral":
        confidence = min(51, 43 + len(text) / 90)
    else:
        confidence = min(92, 52 + abs(raw_direction) * 9 + min(evidence_count, 4) * 3)
    impact_score = min(100, influence + event["impact_boost"] + min(event_matches * 3, 9))
    impact = "高" if impact_score >= 84 else "中等" if impact_score >= 62 else "有限"
    factors = []
    if bullish:
        factors.append(f"偏多词 {bullish} 个")
    if bearish:
        factors.append(f"偏空词 {bearish} 个")
    factors.extend([event["label"], "自动采集"])
    if not evidence_count:
        factors.append("方向词不足")

    direction_sentence = (
        "没有识别到足够明确的方向表达，暂按信息型观点处理"
        if direction == "neutral"
        else f"识别到的{'正向' if direction == 'bullish' else '负向'}措辞更多，整体判断为{direction_label}"
    )
    summary = (
        f"{direction_sentence}。事件类型更接近“{event['label']}”，主要影响窗口预计为{event['horizon']}；"
        "实际有效性仍需结合发布后的 HYPE 价格和相对强弱验证。"
    )
    return {
        "direction": direction,
        "direction_label": direction_label,
        "direction_score": max(-100, min(100, raw_direction * 22)),
        "confidence": round(confidence),
        "impact": impact,
        "impact_score": impact_score,
        "event_type": event["label"],
        "horizon": event["horizon"],
        "factors": factors,
        "summary": summary,
        "engine": "rules-v1-server",
    }


def source_by_handle(handle: str) -> dict:
    return next(source for source in SOURCES if source["handle"].lower() == handle.lower())


def lookup_missing_users(state: dict, bearer_token: str, cost_limit: int) -> tuple[int, bool]:
    missing = [source["handle"] for source in SOURCES if source["handle"].lower() not in state["user_ids"]]
    if not missing:
        return 0, False
    remaining_cost = cost_limit - state["usage"]["estimated_cost_micros"]
    affordable = remaining_cost // USER_READ_COST_MICROS
    handles = missing[:affordable]
    if not handles:
        print("Daily cost guard prevented additional User reads.")
        return 0, False

    payload = api_get("/users/by", bearer_token, {"usernames": ",".join(handles), "user.fields": "id,name,username"})
    users = payload.get("data") if isinstance(payload.get("data"), list) else []
    for user in users:
        state["user_ids"][str(user["username"]).lower()] = str(user["id"])
    actual_reads = len(users)
    state["usage"]["user_reads"] += actual_reads
    state["usage"]["estimated_cost_micros"] += actual_reads * USER_READ_COST_MICROS
    print(f"Resolved {actual_reads} X account IDs.")
    return actual_reads, bool(users)


def timeline_posts(state: dict, source: dict, bearer_token: str) -> list[dict]:
    user_id = state["user_ids"].get(source["handle"].lower())
    if not user_id:
        return []
    params = {
        "max_results": TIMELINE_PAGE_SIZE,
        "exclude": "retweets,replies",
        "tweet.fields": "id,text,author_id,created_at,lang,conversation_id,public_metrics,edit_history_tweet_ids",
    }
    since_id = state["since_ids"].get(source["handle"].lower())
    if since_id:
        params["since_id"] = since_id
    payload = api_get(f"/users/{user_id}/tweets", bearer_token, params)
    posts = payload.get("data") if isinstance(payload.get("data"), list) else []
    newest_id = payload.get("meta", {}).get("newest_id")
    if newest_id:
        state["since_ids"][source["handle"].lower()] = str(newest_id)
    return posts


def normalized_post(post: dict, source: dict, fetched_at: str) -> dict:
    created_at = str(post.get("created_at") or fetched_at)
    return {
        "id": str(post["id"]),
        "author_id": str(post.get("author_id", "")),
        "username": source["handle"],
        "author_name": source["name"],
        "source_role": source["role"],
        "text": str(post.get("text", "")),
        "url": f"https://x.com/{source['handle']}/status/{post['id']}",
        "created_at": created_at,
        "fetched_at": fetched_at,
        "lang": post.get("lang"),
        "conversation_id": str(post.get("conversation_id", "")),
        "public_metrics": post.get("public_metrics") if isinstance(post.get("public_metrics"), dict) else {},
        "analysis": analyze_text(str(post.get("text", "")), int(source["influence"])),
    }


def collect_posts(state: dict, public_data: dict, bearer_token: str, daily_post_limit: int, cost_limit: int) -> tuple[int, bool]:
    existing = {str(post.get("id")): post for post in public_data.get("posts", []) if isinstance(post, dict)}
    new_count = 0
    changed = False
    source_count = len(SOURCES)
    start = int(state.get("source_cursor", 0)) % source_count
    attempted = 0

    while attempted < source_count:
        remaining_posts = daily_post_limit - state["usage"]["analyses"]
        remaining_cost = cost_limit - state["usage"]["estimated_cost_micros"]
        worst_case_cost = TIMELINE_PAGE_SIZE * POST_READ_COST_MICROS
        if remaining_posts < TIMELINE_PAGE_SIZE:
            print("Daily new-post guard reached; no further timelines will be read.")
            break
        if remaining_cost < worst_case_cost:
            print("Daily cost guard reached; no further timelines will be read.")
            break

        index = (start + attempted) % source_count
        source = SOURCES[index]
        posts = timeline_posts(state, source, bearer_token)
        attempted += 1
        state["source_cursor"] = (index + 1) % source_count
        actual_reads = len(posts)
        state["usage"]["post_reads"] += actual_reads
        state["usage"]["estimated_cost_micros"] += actual_reads * POST_READ_COST_MICROS

        fetched_at = now_iso()
        for post in sorted(posts, key=lambda item: str(item.get("created_at", ""))):
            post_id = str(post.get("id", ""))
            if not post_id or post_id in existing:
                continue
            existing[post_id] = normalized_post(post, source, fetched_at)
            state["usage"]["analyses"] += 1
            new_count += 1
            changed = True
        print(f"@{source['handle']}: {actual_reads} Post reads, {new_count} total new analyses this run.")

    posts = sorted(existing.values(), key=lambda item: item.get("created_at", ""), reverse=True)[:MAX_RETAINED_POSTS]
    public_data["posts"] = posts
    return new_count, changed


def update_public_data(public_data: dict, state: dict, cost_limit: int, daily_post_limit: int) -> None:
    public_data.update(
        {
            "version": 1,
            "mode": "x-api-paid",
            "generated_at": now_iso(),
            "timezone": "Asia/Shanghai",
            "daily_limits": {"posts": daily_post_limit, "cost_usd": cost_limit / 1_000_000},
            "usage_today": {
                "date": state["day"],
                "post_reads": state["usage"]["post_reads"],
                "user_reads": state["usage"]["user_reads"],
                "analyses": state["usage"]["analyses"],
                "estimated_cost_usd": state["usage"]["estimated_cost_micros"] / 1_000_000,
            },
            "sources": [
                {
                    **source,
                    "user_id": state["user_ids"].get(source["handle"].lower()),
                    "last_seen_id": state["since_ids"].get(source["handle"].lower()),
                }
                for source in SOURCES
            ],
        }
    )


def set_action_outputs(changed: bool, new_posts: int, state: dict) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as output:
        output.write(f"changed={'true' if changed else 'false'}\n")
        output.write(f"new_posts={new_posts}\n")
        output.write(f"estimated_cost_usd={state['usage']['estimated_cost_micros'] / 1_000_000:.3f}\n")


def main() -> int:
    bearer_token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not bearer_token:
        raise RuntimeError("X_BEARER_TOKEN is not configured")

    daily_post_limit = post_limit()
    daily_cost_limit = cost_limit_micros()
    day = datetime.now(BEIJING).date().isoformat()
    state = load_json(STATE_PATH, default_state(day))
    state, day_changed = normalize_state(state, day)
    original_state = json.dumps(state, sort_keys=True)
    public_data = load_json(PUBLIC_DATA_PATH, {"posts": []})

    lookup_missing_users(state, bearer_token, daily_cost_limit)
    new_posts, posts_changed = collect_posts(state, public_data, bearer_token, daily_post_limit, daily_cost_limit)

    if state["usage"]["analyses"] > daily_post_limit:
        raise RuntimeError("Internal guard failure: daily analysis limit exceeded")
    if state["usage"]["estimated_cost_micros"] > daily_cost_limit:
        raise RuntimeError("Internal guard failure: daily cost limit exceeded")

    state_changed = day_changed or original_state != json.dumps(state, sort_keys=True)
    changed = state_changed or posts_changed
    if changed:
        update_public_data(public_data, state, daily_cost_limit, daily_post_limit)
        write_json(STATE_PATH, state)
        write_json(PUBLIC_DATA_PATH, public_data)

    spent = state["usage"]["estimated_cost_micros"] / 1_000_000
    print(
        f"X daily usage ({day} CST): {state['usage']['analyses']}/{daily_post_limit} analyses, "
        f"estimated ${spent:.3f}/${daily_cost_limit / 1_000_000:.2f}."
    )
    set_action_outputs(changed, new_posts, state)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"X monitor failed: {exc}", file=sys.stderr)
        sys.exit(1)
