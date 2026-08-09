#!/usr/bin/env python3
"""Small dependency-free validation for the static GitHub Pages artifact."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def main() -> None:
    required = [
        SITE / "index.html",
        SITE / "styles.css",
        SITE / "app.js",
        SITE / "manifest.webmanifest",
        SITE / "data" / "x-posts.json",
        SITE / "data" / "market-context.json",
        ROOT / "scripts" / "x_monitor.py",
        ROOT / "scripts" / "market_context.py",
        ROOT / ".github" / "workflows" / "x-monitor.yml",
        ROOT / ".github" / "workflows" / "market-context.yml",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing site files: {', '.join(missing)}")

    html = (SITE / "index.html").read_text(encoding="utf-8")
    stylesheet = (SITE / "styles.css").read_text(encoding="utf-8")
    javascript = (SITE / "app.js").read_text(encoding="utf-8")
    x_data = json.loads((SITE / "data" / "x-posts.json").read_text(encoding="utf-8"))
    x_monitor = (ROOT / "scripts" / "x_monitor.py").read_text(encoding="utf-8")
    x_workflow = (ROOT / ".github" / "workflows" / "x-monitor.yml").read_text(encoding="utf-8")
    market_data = json.loads((SITE / "data" / "market-context.json").read_text(encoding="utf-8"))
    market_collector = (ROOT / "scripts" / "market_context.py").read_text(encoding="utf-8")
    market_workflow = (ROOT / ".github" / "workflows" / "market-context.yml").read_text(encoding="utf-8")
    checks = {
        "responsive viewport": 'name="viewport"' in html,
        "Chinese language": 'lang="zh-CN"' in html,
        "dashboard script": 'src="./app.js' in html,
        "dashboard stylesheet": 'href="./styles.css' in html,
        "Hyperliquid endpoint": "api.hyperliquid.xyz/info" in javascript,
        "15m period": '"15m"' in javascript,
        "1h period": '"1h"' in javascript,
        "4h period": '"4h"' in javascript,
        "1d period": '"1d"' in javascript,
        "single-column charts": ".chart-grid" in stylesheet and "grid-template-columns: minmax(0, 1fr)" in stylesheet,
        "keyboard-accessible charts": 'canvas id="eth-chart" tabindex="0"' in html and 'canvas id="btc-chart" tabindex="0"' in html,
        "chart zoom controls": 'data-zoom="in"' in html and 'data-zoom="out"' in html and 'data-zoom="reset"' in html,
        "wheel zoom": 'addEventListener("wheel"' in javascript,
        "click pinning": "this.pinnedIndex = index" in javascript,
        "crosshair labels": "axisTime" in javascript and "axisValue" in javascript,
        "hidden loading overlays": ".chart-empty[hidden]" in stylesheet and "pointer-events: none" in stylesheet,
        "drag-to-pan charts": "panFromPointer" in javascript and 'classList.add("dragging")' in javascript,
        "readable EMA tooltip": 'class="tooltip-ema"' in javascript and ".tooltip-ema" in stylesheet,
        "social intelligence section": 'id="social-intel"' in html and 'id="opinion-form"' in html,
        "official X embed": "platform.x.com/widgets.js" in html and "twitter-timeline" in javascript,
        "curated HYPE sources": "0xMaxs" in javascript and "louisdives" in javascript and "HyperliquidX" in javascript,
        "manual opinion analysis": "analyzeOpinion" in javascript and "parseXPostUrl" in javascript,
        "local opinion persistence": "OPINION_STORAGE_KEY" in javascript and "saveOpinions" in javascript,
        "multi-horizon opinion checks": "OPINION_HORIZONS" in javascript and "evaluateOpinions" in javascript,
        "weighted opinion summary": 'id="opinion-summary"' in html and "renderOpinionSummary" in javascript and "opinionWeight" in javascript,
        "four hour strategy brief": 'id="four-hour-brief"' in html and "renderFourHourBrief" in javascript and "relativePeriodSignal" in javascript,
        "decision first dashboard": 'class="decision-command"' in html and "data-dashboard-tab" in html and "activateDashboardTab" in javascript,
        "three analysis panels": all(f'data-dashboard-panel="{name}"' in html for name in ("market", "model", "social")),
        "progressive detail disclosures": "model-detail-disclosure" in html and "market-detail-disclosure" in html and "social-settings" in html,
        "condensed opinion records": "visibleRecords.slice(0, 3)" in javascript and 'id="toggle-opinions"' in html,
        "event driven trend model": 'id="model-lab"' in html and "renderWalkForwardModel" in javascript and "simulateTrendStrategy" in javascript,
        "chronological 30 day holdout": "30 * DAY" in javascript and "testingStart" in javascript and 'id="model-trend-recall"' in html,
        "trend capture validation": "evaluateTrendCapture" in javascript and 'id="model-capture-rate"' in html and 'id="model-giveback"' in html,
        "dynamic drawdown exit": "rollingAtrPercent" in javascript and "dynamic-stop" in javascript and 'id="model-invalidation"' in html,
        "price confirmed trend exits": "priceConfirmedReversal" in javascript and "lockedDirection" in javascript and "cooldownUntil" in javascript,
        "trend capture diagnostics": 'id="model-entry-delay"' in html and 'id="model-early-exit"' in html and 'id="model-repeat-signals"' in html,
        "orthogonal technical indicators": all(token in javascript for token in ("technicalIndicatorSeries", "hypeAdx", "hypeAtrPercent", "hypeRoc4h", "hypeVolumeZ")),
        "indicator gated trend entries": "longTrendQuality" in javascript and "shortTrendQuality" in javascript and "momentumAligned" in javascript,
        "live indicator evidence": all(f'id="{element_id}"' in html for element_id in ("model-adx", "model-atr", "model-roc", "model-volume-z", "model-relative-strength", "model-contract-structure")),
        "auxiliary indicator ablation": "baselineCapture" in javascript and 'id="model-aux-impact"' in html,
        "free market context panel": 'id="model-market-context"' in html and "marketStructureSignal" in javascript and "loadMarketContext" in javascript,
        "free market context collector": all(token in market_collector for token in ("metaAndAssetCtxs", "fundingHistory", "l2Book", "recentTrades")),
        "market context retention": market_data.get("snapshot_retention_days") == 60 and market_data.get("funding_retention_days") == 180,
        "market context schedule": 'cron: "11,26,41,56 * * * *"' in market_workflow and "scripts/market_context.py" in market_workflow,
        "summary range and direction filters": "data-summary-window" in html and "data-opinion-filter" in javascript,
        "canonical X snowflake time": "X_SNOWFLAKE_EPOCH" in javascript and "xPostTimestamp" in javascript and "北京时间" in javascript,
        "manual X published time migration": "xSnowflakeTimestamp(parsedPostId)" in javascript and "migrated" in javascript,
        "deduplicated linked opinions": "opinionIdentity" in javascript and "deduplicated" in javascript and "opinion-title-link" in javascript,
        "social mobile layout": ".social-workspace" in stylesheet and ".source-tabs" in stylesheet,
        "paid X data feed": "X_POSTS_URL" in javascript and "loadAutomatedOpinions" in javascript,
        "X API usage display": 'id="x-api-post-usage"' in html and 'id="x-api-cost-usage"' in html,
        "daily post hard cap": "DEFAULT_DAILY_POST_LIMIT = 20" in x_monitor and x_data["daily_limits"]["posts"] == 20,
        "daily cost hard cap": "DEFAULT_DAILY_COST_LIMIT_MICROS = 150_000" in x_monitor and x_data["daily_limits"]["cost_usd"] == 0.15,
        "paid X scheduled workflow": "X_BEARER_TOKEN" in x_workflow and 'X_DAILY_POST_LIMIT: "20"' in x_workflow,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise SystemExit(f"Static validation failed: {', '.join(failed)}")
    print("Static dashboard validation passed.")


if __name__ == "__main__":
    main()
