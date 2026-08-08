#!/usr/bin/env python3
"""Small dependency-free validation for the static GitHub Pages artifact."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def main() -> None:
    required = [SITE / "index.html", SITE / "styles.css", SITE / "app.js", SITE / "manifest.webmanifest"]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing site files: {', '.join(missing)}")

    html = (SITE / "index.html").read_text(encoding="utf-8")
    stylesheet = (SITE / "styles.css").read_text(encoding="utf-8")
    javascript = (SITE / "app.js").read_text(encoding="utf-8")
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
        "social mobile layout": ".social-workspace" in stylesheet and ".source-tabs" in stylesheet,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise SystemExit(f"Static validation failed: {', '.join(failed)}")
    print("Static dashboard validation passed.")


if __name__ == "__main__":
    main()
