const API_URL = "https://api.hyperliquid.xyz/info";
const X_POSTS_URL = "./data/x-posts.json";
const DAY = 24 * 60 * 60 * 1000;
const PERIODS = {
  "15m": { interval: "15m", lookback: 7 * DAY, label: "最近 7 天" },
  "1h": { interval: "1h", lookback: 30 * DAY, label: "最近 30 天" },
  "4h": { interval: "4h", lookback: 90 * DAY, label: "最近 90 天" },
  "1d": { interval: "1d", lookback: 365 * DAY, label: "最近 1 年" },
};
const PERIOD_ORDER = ["15m", "1h", "4h", "1d"];
const CACHE_PREFIX = "hype-lens-v1-";
const OPINION_STORAGE_KEY = "hype-lens-opinions-v1";
const SOCIAL_SOURCES = [
  { handle: "0xMaxs", name: "0xMaxs", role: "交易观点", influence: 72 },
  { handle: "louisdives", name: "Louis", role: "研究 / 数据", influence: 78 },
  { handle: "HyperliquidX", name: "Hyperliquid", role: "官方动态", influence: 90 },
  { handle: "Hyperliquid_Hub", name: "HL Hub", role: "生态资讯", influence: 64 },
  { handle: "HYPEconomist", name: "HYPEconomist", role: "市场观察", influence: 60 },
];
const OPINION_HORIZONS = [
  { key: "15m", label: "15分钟", milliseconds: 15 * 60 * 1000 },
  { key: "1h", label: "1小时", milliseconds: 60 * 60 * 1000 },
  { key: "4h", label: "4小时", milliseconds: 4 * 60 * 60 * 1000 },
  { key: "24h", label: "1日", milliseconds: DAY },
  { key: "7d", label: "7日", milliseconds: 7 * DAY },
];
const SUMMARY_WINDOWS = {
  "24h": { label: "24小时", milliseconds: DAY },
  "3d": { label: "3日", milliseconds: 3 * DAY },
  "7d": { label: "7日", milliseconds: 7 * DAY },
};
const X_SNOWFLAKE_EPOCH = 1288834974657n;

const state = {
  activePeriod: "15m",
  cache: new Map(),
  loading: false,
  opinions: [],
  automatedOpinions: [],
  xUsage: null,
  activeSocialSource: SOCIAL_SOURCES[0].handle,
  summaryWindow: "24h",
  opinionFilter: "all",
};

const $ = (id) => document.getElementById(id);
const formatTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const formatFullTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function ema(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * alpha + output[index - 1] * (1 - alpha));
  }
  return output;
}

function enrich(rows) {
  const eth = rows.map((row) => row.eth);
  const btc = rows.map((row) => row.btc);
  const ethFast = ema(eth, 8);
  const ethSlow = ema(eth, 21);
  const btcFast = ema(btc, 8);
  const btcSlow = ema(btc, 21);
  return rows.map((row, index) => ({
    ...row,
    ethFast: ethFast[index],
    ethSlow: ethSlow[index],
    btcFast: btcFast[index],
    btcSlow: btcSlow[index],
  }));
}

function classify(rows, key) {
  if (!rows || rows.length < 21) return { kind: "neutral", arrow: "→", label: "数据不足" };
  const latest = rows.at(-1);
  const fast = latest[`${key}Fast`];
  const slow = latest[`${key}Slow`];
  const distance = (fast - slow) / slow;
  if (Math.abs(distance) < 0.001) return { kind: "neutral", arrow: "→", label: "震荡" };
  if (distance < 0) return { kind: "strong", arrow: "↓", label: "HYPE 强" };
  return { kind: "weak", arrow: "↑", label: "HYPE 弱" };
}

function percentChange(rows, key, bars) {
  if (!rows || rows.length <= bars) return null;
  const current = rows.at(-1)[key];
  const previous = rows.at(-(bars + 1))[key];
  return ((current / previous) - 1) * 100;
}

function formatPercent(value) {
  if (value === null || !Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1000) return value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  if (value >= 100) return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (value >= 10) return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 3, maximumFractionDigits: 5 });
}

function changeClass(value) {
  if (value === null || Math.abs(value) < 0.01) return "flat";
  return value < 0 ? "negative" : "positive";
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setChange(id, value) {
  const element = $(id);
  element.textContent = formatPercent(value);
  element.className = changeClass(value);
}

function setConnection(kind, text) {
  const element = $("connection-state");
  element.className = `connection ${kind}`;
  element.querySelector("span").textContent = text;
}

function showToast(message, duration = 3500) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, duration);
}

async function fetchCandles(coin, interval, startTime, endTime, attempt = 0) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval, startTime, endTime },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`行情接口返回 ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("行情数据格式异常");
    return payload
      .map((item) => ({ t: Number(item.t), T: Number(item.T), close: Number(item.c) }))
      .filter((item) => Number.isFinite(item.close) && item.T < Date.now() - 3000);
  } catch (error) {
    if (attempt < 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      return fetchCandles(coin, interval, startTime, endTime, attempt + 1);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function alignRatios(ethCandles, btcCandles, hypeCandles) {
  const eth = new Map(ethCandles.map((item) => [item.t, item.close]));
  const btc = new Map(btcCandles.map((item) => [item.t, item.close]));
  return hypeCandles
    .filter((item) => eth.has(item.t) && btc.has(item.t) && item.close > 0)
    .map((item) => ({
      t: item.t,
      eth: eth.get(item.t) / item.close,
      btc: btc.get(item.t) / item.close,
      hype: item.close,
      ethUsd: eth.get(item.t),
      btcUsd: btc.get(item.t),
    }))
    .sort((a, b) => a.t - b.t);
}

function saveLocal(period, rows) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${period}`, JSON.stringify({ savedAt: Date.now(), rows }));
  } catch {
    // Device storage may be unavailable in privacy mode; live data still works.
  }
}

function readLocal(period) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${period}`));
    if (!saved?.rows?.length || Date.now() - saved.savedAt > 7 * DAY) return null;
    return { rows: enrich(saved.rows), savedAt: saved.savedAt, stale: true };
  } catch {
    return null;
  }
}

async function loadPeriod(period, force = false) {
  if (!force && state.cache.has(period)) return state.cache.get(period);
  const config = PERIODS[period];
  const endTime = Date.now();
  const startTime = endTime - config.lookback;
  try {
    const [eth, btc, hype] = await Promise.all([
      fetchCandles("ETH", config.interval, startTime, endTime),
      fetchCandles("BTC", config.interval, startTime, endTime),
      fetchCandles("HYPE", config.interval, startTime, endTime),
    ]);
    const plainRows = alignRatios(eth, btc, hype);
    if (plainRows.length < 25) throw new Error(`${period} 可用数据不足`);
    const result = { rows: enrich(plainRows), savedAt: Date.now(), stale: false };
    state.cache.set(period, result);
    saveLocal(period, plainRows);
    return result;
  } catch (error) {
    const fallback = readLocal(period);
    if (fallback) {
      state.cache.set(period, fallback);
      return fallback;
    }
    throw error;
  }
}

class RatioChart {
  constructor(canvas, tooltip, options) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.options = options;
    this.fullRows = [];
    this.rows = [];
    this.viewStart = 0;
    this.viewEnd = 0;
    this.hoverIndex = null;
    this.pinnedIndex = null;
    this.dragState = null;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.onPointerCancel(event));
    canvas.addEventListener("pointerleave", () => this.onPointerLeave());
    canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    canvas.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  setData(rows) {
    this.fullRows = rows;
    this.viewStart = 0;
    this.viewEnd = rows.length;
    this.updateVisibleRows();
    this.hoverIndex = null;
    this.pinnedIndex = null;
    this.tooltip.hidden = true;
    this.updateZoomUI();
    requestAnimationFrame(() => this.draw());
  }

  updateVisibleRows() {
    this.rows = this.fullRows.slice(this.viewStart, this.viewEnd);
  }

  updateZoomUI() {
    const visible = Math.max(1, this.viewEnd - this.viewStart);
    const full = Math.max(1, this.fullRows.length);
    const zoom = Math.round((full / visible) * 100);
    setText(`${this.options.key}-zoom-level`, `${zoom}%`);
    this.canvas.classList.toggle("can-pan", visible < full);
    document.querySelectorAll(`[data-chart="${this.options.key}"][data-zoom]`).forEach((button) => {
      if (button.dataset.zoom === "out" || button.dataset.zoom === "reset") {
        button.disabled = visible >= full;
      }
      if (button.dataset.zoom === "in") {
        button.disabled = visible <= Math.min(30, full);
      }
    });
  }

  zoomBy(factor, anchorRatio = 0.5) {
    if (this.fullRows.length < 2) return;
    const currentCount = this.viewEnd - this.viewStart;
    const minimumCount = Math.min(30, this.fullRows.length);
    const nextCount = Math.min(
      this.fullRows.length,
      Math.max(minimumCount, Math.round(currentCount * factor))
    );
    if (nextCount === currentCount) return;

    const anchorIndex = this.viewStart + anchorRatio * Math.max(0, currentCount - 1);
    let nextStart = Math.round(anchorIndex - anchorRatio * Math.max(0, nextCount - 1));
    nextStart = Math.max(0, Math.min(this.fullRows.length - nextCount, nextStart));
    this.viewStart = nextStart;
    this.viewEnd = nextStart + nextCount;
    this.updateVisibleRows();
    this.clearPointer(true);
    this.updateZoomUI();
    this.draw();
  }

  resetZoom() {
    this.viewStart = 0;
    this.viewEnd = this.fullRows.length;
    this.updateVisibleRows();
    this.clearPointer(true);
    this.updateZoomUI();
    this.draw();
  }

  dimensions() {
    const width = Math.max(this.canvas.clientWidth, 320);
    const height = Math.max(this.canvas.clientHeight, 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    const context = this.canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { context, width, height, dpr, padding: { top: 16, right: 12, bottom: 34, left: 60 } };
  }

  draw(highlightIndex = this.hoverIndex) {
    const { context, width, height, padding } = this.dimensions();
    context.clearRect(0, 0, width, height);
    if (this.rows.length < 2) return;

    const key = this.options.key;
    const allValues = this.rows.flatMap((row) => [row[key], row[`${key}Fast`], row[`${key}Slow`]]);
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    const spread = Math.max(max - min, max * 0.001);
    min -= spread * 0.12;
    max += spread * 0.12;

    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xFor = (index) => padding.left + (index / (this.rows.length - 1)) * plotWidth;
    const yFor = (value) => padding.top + ((max - value) / (max - min)) * plotHeight;

    context.lineWidth = 1;
    context.font = "11px ui-sans-serif, -apple-system, sans-serif";
    context.textBaseline = "middle";
    for (let line = 0; line <= 4; line += 1) {
      const ratio = line / 4;
      const y = padding.top + ratio * plotHeight;
      const value = max - ratio * (max - min);
      context.strokeStyle = "rgba(214,239,227,0.065)";
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "rgba(139,166,154,0.75)";
      context.textAlign = "right";
      context.fillText(formatRatio(value), padding.left - 8, y);
    }

    const labelIndexes = [0, 0.33, 0.66, 1].map((ratio) => Math.round((this.rows.length - 1) * ratio));
    context.textBaseline = "bottom";
    labelIndexes.forEach((index, labelIndex) => {
      context.fillStyle = "rgba(139,166,154,0.72)";
      context.textAlign = labelIndex === 0 ? "left" : labelIndex === labelIndexes.length - 1 ? "right" : "center";
      context.fillText(formatTime.format(this.rows[index].t), xFor(index), height - 5);
    });

    const mainGradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    mainGradient.addColorStop(0, this.options.fillStart);
    mainGradient.addColorStop(1, "rgba(0,0,0,0)");
    context.beginPath();
    this.rows.forEach((row, index) => {
      const x = xFor(index);
      const y = yFor(row[key]);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.lineTo(xFor(this.rows.length - 1), height - padding.bottom);
    context.lineTo(xFor(0), height - padding.bottom);
    context.closePath();
    context.fillStyle = mainGradient;
    context.fill();

    this.drawLine(context, this.rows.map((row) => row[`${key}Slow`]), xFor, yFor, this.options.slow, 1.6);
    this.drawLine(context, this.rows.map((row) => row[`${key}Fast`]), xFor, yFor, this.options.fast, 1.9);
    this.drawLine(context, this.rows.map((row) => row[key]), xFor, yFor, this.options.main, 2.05);

    if (this.viewEnd === this.fullRows.length) {
      const lastIndex = this.rows.length - 1;
      context.beginPath();
      context.arc(xFor(lastIndex), yFor(this.rows[lastIndex][key]), 3, 0, Math.PI * 2);
      context.fillStyle = this.options.main;
      context.fill();
      context.beginPath();
      context.arc(xFor(lastIndex), yFor(this.rows[lastIndex][key]), 6, 0, Math.PI * 2);
      context.strokeStyle = this.options.glow;
      context.stroke();
    }

    if (Number.isInteger(highlightIndex) && highlightIndex >= 0 && highlightIndex < this.rows.length) {
      const x = xFor(highlightIndex);
      const y = yFor(this.rows[highlightIndex][key]);
      const row = this.rows[highlightIndex];
      context.beginPath();
      context.moveTo(x, padding.top);
      context.lineTo(x, height - padding.bottom);
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.strokeStyle = "rgba(236,247,240,0.2)";
      context.setLineDash([3, 4]);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fillStyle = "#07110f";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = this.options.main;
      context.stroke();

      const axisTime = formatTime.format(row.t);
      const timeWidth = Math.ceil(context.measureText(axisTime).width) + 14;
      const timeLeft = Math.max(padding.left, Math.min(width - padding.right - timeWidth, x - timeWidth / 2));
      context.fillStyle = "rgba(6,16,13,0.96)";
      context.fillRect(timeLeft, height - padding.bottom + 5, timeWidth, 22);
      context.fillStyle = this.options.main;
      context.font = "11px ui-sans-serif, -apple-system, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(axisTime, timeLeft + timeWidth / 2, height - padding.bottom + 16);

      const axisValue = formatRatio(row[key]);
      context.fillStyle = "rgba(6,16,13,0.96)";
      context.fillRect(0, y - 11, padding.left - 5, 22);
      context.fillStyle = this.options.main;
      context.textAlign = "right";
      context.fillText(axisValue, padding.left - 9, y);
    }

    this.geometry = { xFor, yFor, padding, width, height, plotWidth };
  }

  drawLine(context, values, xFor, yFor, color, width) {
    context.beginPath();
    values.forEach((value, index) => {
      if (index === 0) context.moveTo(xFor(index), yFor(value));
      else context.lineTo(xFor(index), yFor(value));
    });
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }

  pointerIndex(event) {
    if (!this.rows.length || !this.geometry) return;
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, (localX - this.geometry.padding.left) / this.geometry.plotWidth));
    return Math.round(ratio * (this.rows.length - 1));
  }

  showPoint(index) {
    if (!Number.isInteger(index) || !this.rows[index]) return;
    this.hoverIndex = index;
    const row = this.rows[index];
    const key = this.options.key;
    this.draw(this.hoverIndex);
    const pinnedLabel = this.pinnedIndex === index ? " · 已固定" : "";
    this.tooltip.innerHTML = `<span class="tooltip-time">${formatFullTime.format(row.t)}${pinnedLabel}</span><strong>${formatRatio(row[key])}</strong><span class="tooltip-ema"><i>EMA 8</i><b>${formatRatio(row[`${key}Fast`])}</b></span><span class="tooltip-ema"><i>EMA 21</i><b>${formatRatio(row[`${key}Slow`])}</b></span>`;
    this.tooltip.hidden = false;
    const pointX = this.geometry.xFor(this.hoverIndex);
    const tooltipWidth = Math.max(180, this.tooltip.offsetWidth || 180);
    const left = pointX > this.geometry.width * 0.68 ? pointX - tooltipWidth - 10 : pointX + 10;
    this.tooltip.style.left = `${Math.max(4, Math.min(this.geometry.width - tooltipWidth - 4, left))}px`;
    this.tooltip.style.top = "12px";
  }

  onPointerMove(event) {
    if (this.dragState) {
      this.panFromPointer(event);
      return;
    }
    if (this.pinnedIndex !== null || event.pointerType === "touch") return;
    this.showPoint(this.pointerIndex(event));
  }

  onPointerDown(event) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const visible = this.viewEnd - this.viewStart;
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startViewStart: this.viewStart,
      canPan: visible < this.fullRows.length,
      moved: false,
    };
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  panFromPointer(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId || !this.dragState.canPan) return;
    const distance = event.clientX - this.dragState.startX;
    if (Math.abs(distance) < 3 && !this.dragState.moved) return;
    this.dragState.moved = true;
    this.canvas.classList.add("dragging");

    const visible = this.viewEnd - this.viewStart;
    const barsPerPixel = visible / Math.max(1, this.geometry?.plotWidth || this.canvas.clientWidth);
    const shift = Math.round(-distance * barsPerPixel);
    const nextStart = Math.max(
      0,
      Math.min(this.fullRows.length - visible, this.dragState.startViewStart + shift)
    );
    if (nextStart === this.viewStart) return;
    this.viewStart = nextStart;
    this.viewEnd = nextStart + visible;
    this.updateVisibleRows();
    this.hoverIndex = null;
    this.pinnedIndex = null;
    this.tooltip.hidden = true;
    this.draw();
  }

  onPointerUp(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    const moved = this.dragState.moved;
    this.finishDrag(event.pointerId);
    if (!moved) this.onClick(event);
  }

  onPointerCancel(event) {
    if (this.dragState?.pointerId === event.pointerId) this.finishDrag(event.pointerId);
  }

  finishDrag(pointerId) {
    if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.dragState = null;
    this.canvas.classList.remove("dragging");
  }

  onClick(event) {
    const index = this.pointerIndex(event);
    if (!Number.isInteger(index)) return;
    if (this.pinnedIndex === index) {
      this.clearPointer(true);
      return;
    }
    this.pinnedIndex = index;
    this.showPoint(index);
  }

  onPointerLeave() {
    if (this.dragState) return;
    if (this.pinnedIndex === null) this.clearPointer();
  }

  onWheel(event) {
    event.preventDefault();
    if (!this.geometry) return;
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const anchorRatio = Math.min(
      1,
      Math.max(0, (localX - this.geometry.padding.left) / this.geometry.plotWidth)
    );
    this.zoomBy(event.deltaY < 0 ? 0.75 : 1.35, anchorRatio);
  }

  onKeyDown(event) {
    if (event.key === "Escape") {
      this.clearPointer(true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const current = this.pinnedIndex ?? this.hoverIndex ?? this.rows.length - 1;
    const next = Math.max(0, Math.min(this.rows.length - 1, current + direction));
    this.pinnedIndex = next;
    this.showPoint(next);
  }

  clearPointer(force = false) {
    if (!force && this.pinnedIndex !== null) return;
    this.hoverIndex = null;
    this.pinnedIndex = null;
    this.tooltip.hidden = true;
    this.draw();
  }
}

const ethChart = new RatioChart($("eth-chart"), $("eth-tooltip"), {
  key: "eth",
  main: "#aebaff",
  fast: "rgba(119,199,255,0.92)",
  slow: "rgba(100,136,201,0.78)",
  fillStart: "rgba(144,165,255,0.15)",
  glow: "rgba(174,186,255,0.42)",
});
const btcChart = new RatioChart($("btc-chart"), $("btc-tooltip"), {
  key: "btc",
  main: "#f2b861",
  fast: "rgba(255,217,141,0.92)",
  slow: "rgba(216,143,77,0.78)",
  fillStart: "rgba(242,184,97,0.14)",
  glow: "rgba(242,184,97,0.4)",
});

const charts = { eth: ethChart, btc: btcChart };
document.querySelectorAll("[data-chart][data-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    const chart = charts[button.dataset.chart];
    if (!chart) return;
    if (button.dataset.zoom === "in") chart.zoomBy(0.7);
    else if (button.dataset.zoom === "out") chart.zoomBy(1.4);
    else chart.resetZoom();
  });
});

function renderCharts(period) {
  const result = state.cache.get(period);
  if (!result) return;
  setText("range-label", `${PERIODS[period].label} · 北京时间`);
  $("eth-chart-empty").hidden = true;
  $("btc-chart-empty").hidden = true;
  ethChart.setData(result.rows);
  btcChart.setData(result.rows);
}

function updateTrendPill(id, trend) {
  const pill = $(id);
  pill.className = `trend-pill ${trend.kind}`;
  pill.textContent = `${trend.arrow} ${trend.label}`;
}

function renderMetrics() {
  const result = state.cache.get("15m");
  if (!result) return;
  const rows = result.rows;
  const latest = rows.at(-1);
  setText("eth-value", formatRatio(latest.eth));
  setText("btc-value", formatRatio(latest.btc));
  updateTrendPill("eth-trend", classify(rows, "eth"));
  updateTrendPill("btc-trend", classify(rows, "btc"));
  [["eth", "eth"], ["btc", "btc"]].forEach(([prefix, key]) => {
    setChange(`${prefix}-change-1h`, percentChange(rows, key, 4));
    setChange(`${prefix}-change-4h`, percentChange(rows, key, 16));
    setChange(`${prefix}-change-24h`, percentChange(rows, key, 96));
  });
  setText("last-updated", `更新于 ${formatFullTime.format(result.savedAt)} CST${result.stale ? " · 缓存" : ""}`);
  evaluateOpinions();
  renderFourHourBrief();
}

function renderMatrix() {
  if (!PERIOD_ORDER.every((period) => state.cache.has(period))) return;
  const trends = { eth: {}, btc: {} };
  ["eth", "btc"].forEach((key) => {
    PERIOD_ORDER.forEach((period) => {
      trends[key][period] = classify(state.cache.get(period).rows, key);
    });
  });

  const matrix = $("trend-matrix");
  matrix.innerHTML = `
    <div class="matrix-row matrix-header">
      <span>比值</span><span>15m</span><span>1h</span><span>4h</span><span>1d</span>
    </div>
    ${["eth", "btc"].map((key) => `
      <div class="matrix-row">
        <strong>${key.toUpperCase()}/HYPE</strong>
        ${PERIOD_ORDER.map((period) => {
          const trend = trends[key][period];
          return `<span class="matrix-cell ${trend.kind}">${trend.arrow} ${trend.label.replace("HYPE ", "")}</span>`;
        }).join("")}
      </div>
    `).join("")}
  `;

  const allTrends = ["eth", "btc"].flatMap((key) => PERIOD_ORDER.map((period) => trends[key][period]));
  const strongCount = allTrends.filter((trend) => trend.kind === "strong").length;
  const weakCount = allTrends.filter((trend) => trend.kind === "weak").length;
  let label = "多周期分化";
  let detail = `${strongCount} 个强势 · ${weakCount} 个弱势信号`;
  if (strongCount >= 7) label = "HYPE 强势共振";
  else if (strongCount >= 5) label = "HYPE 相对偏强";
  else if (weakCount >= 7) label = "HYPE 明显偏弱";
  else if (weakCount >= 5) label = "HYPE 相对偏弱";
  setText("strength-score", `${strongCount}/8`);
  setText("strength-label", label);
  setText("strength-detail", detail);
  $("hero-state").classList.remove("loading-block");
  renderSignals(trends, strongCount, weakCount);
}

function renderSignals(trends, strongCount, weakCount) {
  const rows = state.cache.get("15m").rows;
  const eth24h = percentChange(rows, "eth", 96);
  const btc24h = percentChange(rows, "btc", 96);
  const bothDown = eth24h < 0 && btc24h < 0;
  const bothUp = eth24h > 0 && btc24h > 0;
  const alignedPeriods = PERIOD_ORDER.filter((period) =>
    trends.eth[period].kind === trends.btc[period].kind && trends.eth[period].kind !== "neutral"
  );

  const signals = [];
  if (strongCount >= 5) {
    signals.push({ icon: "↓", title: "HYPE 相对强势占优", text: `8 个趋势观察中有 ${strongCount} 个指向 HYPE 走强。`, type: "good" });
  } else if (weakCount >= 5) {
    signals.push({ icon: "↑", title: "HYPE 相对表现偏弱", text: `8 个趋势观察中有 ${weakCount} 个指向 HYPE 走弱。`, type: "warning" });
  } else {
    signals.push({ icon: "↔", title: "市场暂处于分化", text: "BTC 与 ETH 对 HYPE 的趋势尚未形成明显共振。", type: "neutral" });
  }

  if (bothDown) {
    signals.push({ icon: "24", title: "过去 24 小时 HYPE 占优", text: `ETH/HYPE ${formatPercent(eth24h)}，BTC/HYPE ${formatPercent(btc24h)}。`, type: "good" });
  } else if (bothUp) {
    signals.push({ icon: "24", title: "过去 24 小时 HYPE 落后", text: `ETH/HYPE ${formatPercent(eth24h)}，BTC/HYPE ${formatPercent(btc24h)}。`, type: "warning" });
  } else {
    signals.push({ icon: "24", title: "过去 24 小时走势分化", text: `ETH/HYPE ${formatPercent(eth24h)}，BTC/HYPE ${formatPercent(btc24h)}。`, type: "neutral" });
  }

  signals.push({
    icon: "◎",
    title: alignedPeriods.length ? `${alignedPeriods.length} 个周期方向一致` : "暂无双比值共振",
    text: alignedPeriods.length ? `共振周期：${alignedPeriods.join("、")}。` : "等待 ETH/HYPE 与 BTC/HYPE 出现同向趋势。",
    type: alignedPeriods.length >= 3 ? "good" : "neutral",
  });

  $("signal-list").innerHTML = signals.map((signal) => `
    <div class="signal-item ${signal.type === "warning" ? "warning" : ""}">
      <span class="signal-icon">${signal.icon}</span>
      <div><strong>${signal.title}</strong><span>${signal.text}</span></div>
    </div>
  `).join("");
}

async function switchPeriod(period) {
  state.activePeriod = period;
  document.querySelectorAll("[data-period]").forEach((button) => {
    const active = button.dataset.period === period;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (state.cache.has(period)) {
    renderCharts(period);
    return;
  }
  $("eth-chart-empty").hidden = false;
  $("btc-chart-empty").hidden = false;
  try {
    await loadPeriod(period);
    if (state.activePeriod === period) renderCharts(period);
  } catch (error) {
    $("eth-chart-empty").textContent = "该周期暂时无法载入";
    $("btc-chart-empty").textContent = "该周期暂时无法载入";
    showToast(error.message || "行情加载失败");
  }
}

async function refreshAll(force = false) {
  if (state.loading) return;
  state.loading = true;
  const button = $("refresh-button");
  button.disabled = true;
  button.classList.add("spinning");
  setConnection("", "正在连接");
  if (force) state.cache.clear();

  try {
    const primary = await loadPeriod("15m", force);
    renderMetrics();
    if (state.activePeriod === "15m") renderCharts("15m");
    setConnection(primary.stale ? "error" : "online", primary.stale ? "显示缓存" : "行情在线");

    const secondaryResults = await Promise.allSettled(
      PERIOD_ORDER.slice(1).map((period) => loadPeriod(period, force))
    );
    const failed = secondaryResults.filter((result) => result.status === "rejected").length;
    renderMatrix();
    evaluateOpinions();
    renderFourHourBrief();
    if (state.cache.has(state.activePeriod)) renderCharts(state.activePeriod);
    if (failed) showToast(`${failed} 个大周期暂时未更新，已显示可用数据`);
    else if (force) showToast("行情已更新");
  } catch (error) {
    setConnection("error", "连接异常");
    $("eth-chart-empty").textContent = "行情连接失败，请稍后刷新";
    $("btc-chart-empty").textContent = "行情连接失败，请稍后刷新";
    showToast(error.message || "无法连接行情接口", 5000);
  } finally {
    state.loading = false;
    button.disabled = false;
    button.classList.remove("spinning");
  }
}

const DIRECTION_RULES = {
  bullish: [
    "bullish", "accumulate", "accumulation", "long $hype", "buy $hype", "breakout", "undervalued",
    "adoption", "growth", "record revenue", "new high", "all-time high", "ath", "buyback", "burn",
    "看多", "做多", "买入", "加仓", "积累", "突破", "低估", "采用增长", "收入新高", "历史新高", "回购", "销毁",
  ],
  bearish: [
    "bearish", "short $hype", "sell $hype", "breakdown", "overvalued", "unlock", "exploit", "hacked",
    "outage", "outflow", "weakness", "dump", "liquidation risk", "看空", "做空", "卖出", "减仓", "跌破",
    "高估", "解锁", "漏洞", "被盗", "宕机", "资金流出", "弱势", "砸盘", "清算风险",
  ],
};

const EVENT_RULES = [
  {
    key: "security",
    label: "安全 / 运行事件",
    terms: ["exploit", "hack", "hacked", "vulnerability", "outage", "downtime", "incident", "漏洞", "攻击", "被盗", "宕机", "故障"],
    impactBoost: 16,
    horizon: "数小时至 7 天",
  },
  {
    key: "policy",
    label: "监管 / 上市事件",
    terms: ["etf", "sec", "regulation", "regulatory", "listing", "delist", "approval", "监管", "合规", "上币", "下架", "批准"],
    impactBoost: 14,
    horizon: "1 天至数周",
  },
  {
    key: "fundamental",
    label: "基本面 / 生态事件",
    terms: ["revenue", "fees", "volume", "buyback", "burn", "hip-", "adoption", "integration", "users", "open interest", "收入", "手续费", "交易量", "回购", "销毁", "采用", "集成", "用户增长", "持仓量"],
    impactBoost: 10,
    horizon: "数日至数月",
  },
  {
    key: "technical",
    label: "技术面 / 仓位观点",
    terms: ["breakout", "breakdown", "support", "resistance", "chart", "rsi", "funding", "liquidation", "target", "突破", "跌破", "支撑", "阻力", "技术面", "资金费率", "清算", "目标位"],
    impactBoost: 4,
    horizon: "数小时至 3 天",
  },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countTerms(text, terms) {
  const normalized = text.toLowerCase();
  return terms.reduce((count, term) => {
    const matches = normalized.match(new RegExp(escapeRegExp(term.toLowerCase()), "g"));
    return count + (matches?.length || 0);
  }, 0);
}

function sourceFor(handle) {
  return SOCIAL_SOURCES.find((source) => source.handle.toLowerCase() === String(handle).toLowerCase()) || {
    handle,
    name: handle,
    role: "其他账号",
    influence: 50,
  };
}

function parseXPostUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"];
  if (!allowed.includes(hostname)) return null;
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!match) return null;
  return { url: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1], postId: match[2] };
}

function analyzeOpinion(text, handle) {
  const bullishMatches = countTerms(text, DIRECTION_RULES.bullish);
  const bearishMatches = countTerms(text, DIRECTION_RULES.bearish);
  const rawDirection = bullishMatches - bearishMatches;
  let direction = "neutral";
  let directionLabel = "中性 / 信息型";
  if (rawDirection > 0) {
    direction = "bullish";
    directionLabel = "偏多";
  } else if (rawDirection < 0) {
    direction = "bearish";
    directionLabel = "偏空";
  }

  const eventMatches = EVENT_RULES
    .map((event) => ({ ...event, matches: countTerms(text, event.terms) }))
    .filter((event) => event.matches > 0)
    .sort((a, b) => (b.matches + b.impactBoost / 20) - (a.matches + a.impactBoost / 20));
  const event = eventMatches[0] || {
    key: "commentary",
    label: "一般市场观点",
    impactBoost: 0,
    horizon: "数小时至 3 天",
    matches: 0,
  };

  const source = sourceFor(handle);
  const directionalEvidence = bullishMatches + bearishMatches;
  const confidence = Math.min(
    92,
    Math.max(40, direction === "neutral" ? 43 + Math.min(text.length / 90, 8) : 52 + Math.abs(rawDirection) * 9 + Math.min(directionalEvidence, 4) * 3)
  );
  const directionScore = Math.max(-100, Math.min(100, rawDirection * 22));
  const impactScore = Math.min(100, source.influence + event.impactBoost + Math.min(event.matches * 3, 9));
  const impact = impactScore >= 84 ? "高" : impactScore >= 62 ? "中等" : "有限";
  const evidence = [];
  if (bullishMatches) evidence.push(`偏多词 ${bullishMatches} 个`);
  if (bearishMatches) evidence.push(`偏空词 ${bearishMatches} 个`);
  evidence.push(event.label);
  evidence.push(`${source.role}来源`);
  if (!directionalEvidence) evidence.push("方向词不足");

  const directionSentence = direction === "neutral"
    ? "没有识别到足够明确的方向表达，暂按信息型观点处理"
    : `识别到的${direction === "bullish" ? "正向" : "负向"}措辞更多，整体判断为${directionLabel}`;
  const summary = `${directionSentence}。事件类型更接近“${event.label}”，主要影响窗口预计为${event.horizon}；实际有效性仍需结合发布后的 HYPE 价格和相对强弱验证。`;

  return {
    direction,
    directionLabel,
    directionScore,
    confidence: Math.round(confidence),
    impact,
    impactScore,
    eventType: event.label,
    horizon: event.horizon,
    factors: evidence,
    summary,
    engine: "rules-v1",
  };
}

function latestMarketSnapshot() {
  const row = state.cache.get("15m")?.rows?.at(-1);
  if (!row || !Number.isFinite(row.hype)) return null;
  return { t: row.t, hype: row.hype, eth: row.eth, btc: row.btc };
}

function readOpinions() {
  try {
    const records = JSON.parse(localStorage.getItem(OPINION_STORAGE_KEY));
    if (!Array.isArray(records)) return [];
    let migrated = false;
    const normalized = records.slice(0, 50).map((record) => {
      const parsedPostId = record.postId || parseXPostUrl(record.url || "")?.postId;
      const publishedAt = xSnowflakeTimestamp(parsedPostId);
      if (!Number.isFinite(publishedAt) || record.createdAt === publishedAt) return record;
      migrated = true;
      return { ...record, postId: parsedPostId, createdAt: publishedAt };
    });
    if (migrated) localStorage.setItem(OPINION_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return [];
  }
}

function saveOpinions() {
  try {
    localStorage.setItem(OPINION_STORAGE_KEY, JSON.stringify(state.opinions.slice(0, 50)));
  } catch {
    showToast("浏览器未允许本机保存，刷新后记录可能丢失");
  }
}

function opinionIdentity(record) {
  const postId = record.postId || parseXPostUrl(record.url || "")?.postId;
  if (postId) return `post:${postId}`;
  return `record:${record.id}`;
}

function allOpinions() {
  const deduplicated = new Map();
  [...state.opinions, ...state.automatedOpinions].forEach((record) => {
    const key = opinionIdentity(record);
    const existing = deduplicated.get(key);
    if (!existing || record.origin === "x-api") deduplicated.set(key, record);
  });
  return [...deduplicated.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 100);
}

function xSnowflakeTimestamp(id) {
  let snowflakeTime = Number.NaN;
  try {
    const snowflake = BigInt(String(id || ""));
    snowflakeTime = Number((snowflake >> 22n) + X_SNOWFLAKE_EPOCH);
  } catch {
    // Older hand-entered records may not have a valid X snowflake ID.
  }
  const plausibleSnowflake = Number.isFinite(snowflakeTime)
    && snowflakeTime >= Date.UTC(2006, 0, 1)
    && snowflakeTime <= Date.now() + DAY;
  return plausibleSnowflake ? snowflakeTime : Number.NaN;
}

function xPostTimestamp(post) {
  const snowflakeTime = xSnowflakeTimestamp(post.id);
  if (Number.isFinite(snowflakeTime)) return snowflakeTime;
  const apiTime = Date.parse(post.created_at || post.fetched_at || "");
  return Number.isFinite(apiTime) ? apiTime : Date.now();
}

function normalizeAutomatedOpinion(post) {
  const analysis = post.analysis || {};
  const createdAt = xPostTimestamp(post);
  return {
    id: String(post.id),
    createdAt,
    author: post.username,
    postId: String(post.id),
    url: post.url,
    text: post.text || "",
    publicMetrics: post.public_metrics || {},
    origin: "x-api",
    analysis: {
      direction: analysis.direction || "neutral",
      directionLabel: analysis.direction_label || "中性 / 信息型",
      directionScore: Number(analysis.direction_score || 0),
      confidence: Number(analysis.confidence || 0),
      impact: analysis.impact || "有限",
      impactScore: Number(analysis.impact_score || 0),
      eventType: analysis.event_type || "一般市场观点",
      horizon: analysis.horizon || "数小时至 3 天",
      factors: Array.isArray(analysis.factors) ? analysis.factors : [],
      summary: analysis.summary || "等待分析摘要。",
      engine: analysis.engine || "rules-v1-server",
    },
    baseline: null,
    measurements: {},
  };
}

function summaryDirection(score) {
  if (score >= 18) return { key: "bullish", label: "偏多" };
  if (score <= -18) return { key: "bearish", label: "偏空" };
  return { key: "neutral", label: "中性 / 分歧" };
}

function opinionWeight(record, now, windowSize) {
  const analysis = record.analysis || {};
  const sourceWeight = Math.max(0.45, sourceFor(record.author).influence / 100);
  const confidenceWeight = Math.max(0.4, Number(analysis.confidence || 40) / 100);
  const impactWeight = analysis.impact === "高" ? 1.2 : analysis.impact === "中等" ? 1 : 0.8;
  const metrics = record.publicMetrics || {};
  const engagement = Number(metrics.like_count || 0) + Number(metrics.retweet_count || 0) * 2;
  const engagementWeight = 1 + Math.min(Math.log10(engagement + 1) * 0.08, 0.24);
  const age = Math.max(0, now - record.createdAt);
  const recencyWeight = Math.max(0.35, 1 - age / Math.max(windowSize * 1.35, 1));
  return sourceWeight * confidenceWeight * impactWeight * engagementWeight * recencyWeight;
}

function relativePeriodSignal(period) {
  const rows = state.cache.get(period)?.rows;
  if (!rows || rows.length < 21) return null;
  const latest = rows.at(-1);
  const pairScores = ["eth", "btc"].map((key) => {
    const fast = Number(latest[`${key}Fast`]);
    const slow = Number(latest[`${key}Slow`]);
    if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow === 0) return 0;
    const distance = (fast - slow) / slow;
    return Math.max(-100, Math.min(100, (-distance / 0.006) * 100));
  });
  const score = Math.round(pairScores.reduce((sum, value) => sum + value, 0) / pairScores.length);
  const key = score >= 15 ? "bullish" : score <= -15 ? "bearish" : "neutral";
  const label = key === "bullish" ? "HYPE偏强" : key === "bearish" ? "HYPE偏弱" : "震荡";
  return { score, key, label };
}

function recentOpinionSignal(records, now = Date.now()) {
  const scoped = records.filter((record) => record.createdAt <= now && now - record.createdAt <= DAY);
  if (!scoped.length) return null;
  let weightedScore = 0;
  let totalWeight = 0;
  scoped.forEach((record) => {
    const weight = opinionWeight(record, now, DAY);
    weightedScore += Number(record.analysis?.directionScore || 0) * weight;
    totalWeight += weight;
  });
  const score = totalWeight ? Math.round(weightedScore / totalWeight) : 0;
  const direction = summaryDirection(score);
  return { score, key: direction.key, label: `${direction.label} · ${scoped.length}条` };
}

function renderFourHourBrief() {
  const panel = $("four-hour-brief");
  if (!panel) return;
  const components = [
    { id: "15m", label: "15分钟", weight: 0.2, signal: relativePeriodSignal("15m") },
    { id: "1h", label: "1小时", weight: 0.25, signal: relativePeriodSignal("1h") },
    { id: "4h", label: "4小时", weight: 0.3, signal: relativePeriodSignal("4h") },
    { id: "opinion", label: "观点汇总", weight: 0.25, signal: recentOpinionSignal(allOpinions()) },
  ];
  const available = components.filter((component) => component.signal);
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  if (!available.length || !availableWeight) return;

  const score = Math.round(available.reduce((sum, component) => (
    sum + component.signal.score * component.weight
  ), 0) / availableWeight);
  const direction = score >= 25
    ? { key: "bullish", label: "条件偏强" }
    : score <= -25
      ? { key: "bearish", label: "条件偏弱" }
      : { key: "neutral", label: "观望为主" };
  const directional = available.filter((component) => Math.abs(component.signal.score) >= 15);
  const positive = directional.filter((component) => component.signal.score > 0).length;
  const negative = directional.filter((component) => component.signal.score < 0).length;
  const alignment = directional.length ? Math.max(positive, negative) / directional.length : 0.5;
  const completeness = availableWeight;
  const confidence = Math.min(92, Math.round(32 + completeness * 24 + alignment * 23 + Math.min(Math.abs(score) * 0.22, 13)));
  const marketLabels = components.slice(0, 3).map((component) => (
    `${component.label}${component.signal ? component.signal.label : "待更新"}`
  )).join("、");
  const opinion = components[3].signal;
  const opinionText = opinion ? `最近24小时观点为${opinion.label}` : "最近24小时观点数据不足";
  const summary = `${marketLabels}；${opinionText}。综合评分 ${score > 0 ? "+" : ""}${score}/100。`;
  const condition = direction.key === "bullish"
    ? "策略参考：等待回踩确认，避免追高；只有15分钟与1小时保持同向、且4小时不转弱时，偏强判断才继续有效。"
    : direction.key === "bearish"
      ? "策略参考：优先控制风险，避免逆势追多；只有15分钟与1小时先转强、且4小时停止走弱时，才视为修复信号。"
      : "策略参考：暂不依据单一周期采取动作；等待15分钟与1小时同向，并获得4小时趋势或观点共识确认。";

  panel.classList.remove("loading-block");
  panel.dataset.direction = direction.key;
  const stance = $("four-hour-stance");
  stance.className = `four-hour-stance ${direction.key}`;
  stance.textContent = direction.label;
  setText("four-hour-summary", summary);
  setText("four-hour-condition", condition);
  setText("four-hour-score", `${score > 0 ? "+" : ""}${score}`);
  setText("four-hour-confidence", `置信度 ${confidence}%`);
  $("four-hour-signals").innerHTML = components.map((component) => {
    const signal = component.signal || { key: "neutral", label: "待更新", score: 0 };
    return `<span class="${signal.key}"><small>${component.label}</small><strong>${escapeHtml(signal.label)}</strong></span>`;
  }).join("");
}

function horizonBucket(horizon = "") {
  if (/月|周/.test(horizon)) return "中长期";
  if (/7 天|7天|数日|1 天|1天|3 天|3天/.test(horizon)) return "未来数日";
  return "未来数小时";
}

function topOpinionFactors(records, direction) {
  const counts = new Map();
  records
    .filter((record) => record.analysis?.direction === direction)
    .forEach((record) => {
      const label = record.analysis?.eventType || "一般市场观点";
      counts.set(label, (counts.get(label) || 0) + 1);
    });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([label, count]) => `${label} · ${count}`);
}

function aggregateHorizon(records, bucket, now, windowSize) {
  const candidates = records.filter((record) => horizonBucket(record.analysis?.horizon) === bucket);
  if (!candidates.length) return { label: "暂无明确观点", key: "neutral" };
  let weightedScore = 0;
  let totalWeight = 0;
  candidates.forEach((record) => {
    const weight = opinionWeight(record, now, windowSize);
    weightedScore += Number(record.analysis?.directionScore || 0) * weight;
    totalWeight += weight;
  });
  const score = totalWeight ? Math.round(weightedScore / totalWeight) : 0;
  const direction = summaryDirection(score);
  return { label: `${direction.label} ${score > 0 ? "+" : ""}${score}`, key: direction.key };
}

function renderOpinionSummary(records) {
  const container = $("opinion-summary-content");
  if (!container) return;
  const windowConfig = SUMMARY_WINDOWS[state.summaryWindow] || SUMMARY_WINDOWS["24h"];
  const now = Date.now();
  const scoped = records.filter((record) => now - record.createdAt <= windowConfig.milliseconds);
  document.querySelectorAll("[data-summary-window]").forEach((button) => {
    const active = button.dataset.summaryWindow === state.summaryWindow;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (!scoped.length) {
    container.innerHTML = `<p class="summary-empty">最近${windowConfig.label}暂无可汇总的新观点，请切换更长时间范围。</p>`;
    return;
  }

  let weightedScore = 0;
  let totalWeight = 0;
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  scoped.forEach((record) => {
    const weight = opinionWeight(record, now, windowConfig.milliseconds);
    weightedScore += Number(record.analysis?.directionScore || 0) * weight;
    totalWeight += weight;
    counts[record.analysis?.direction || "neutral"] += 1;
  });
  const score = totalWeight ? Math.round(weightedScore / totalWeight) : 0;
  const direction = summaryDirection(score);
  const directionalTotal = counts.bullish + counts.bearish;
  const minorityShare = directionalTotal ? Math.min(counts.bullish, counts.bearish) / directionalTotal : 0;
  const disagreement = minorityShare >= 0.35 ? "分歧较高" : minorityShare >= 0.15 ? "存在分歧" : directionalTotal ? "方向较一致" : "方向信息不足";
  const authors = new Set(scoped.map((record) => String(record.author).toLowerCase())).size;
  const measurements = scoped.flatMap((record) => Object.values(record.measurements || {}));
  const hitRate = measurements.length
    ? Math.round(measurements.filter((measurement) => measurement.hit).length / measurements.length * 100)
    : null;
  const verification = hitRate === null ? "价格验证数据仍在积累" : `已有 ${measurements.length} 个验证点，${hitRate}% 符合原判断`;
  const latest = Math.max(...scoped.map((record) => record.createdAt));
  const bullishFactors = topOpinionFactors(scoped, "bullish");
  const bearishFactors = topOpinionFactors(scoped, "bearish");
  const summarySentence = `最近${windowConfig.label}综合判断为${direction.label}（${score > 0 ? "+" : ""}${score}/100），${disagreement}。${verification}。`;

  container.innerHTML = `
    <div class="summary-overview">
      <div class="summary-score ${direction.key}">
        <small>综合共识</small>
        <strong>${score > 0 ? "+" : ""}${score}</strong>
        <span>${direction.label}</span>
      </div>
      <div class="summary-narrative">
        <p>${escapeHtml(summarySentence)}</p>
        <div class="summary-meter" aria-label="综合共识分数 ${score}"><i style="--summary-score: ${Math.max(0, Math.min(100, (score + 100) / 2))}%"></i></div>
        <small>${scoped.length} 条帖子 · ${authors} 位博主 · 更新至 ${formatFullTime.format(latest)} 北京时间</small>
      </div>
    </div>
    <div class="summary-stat-grid">
      <button type="button" data-opinion-filter="bullish"><small>偏多</small><strong>${counts.bullish} 条</strong></button>
      <button type="button" data-opinion-filter="bearish"><small>偏空</small><strong>${counts.bearish} 条</strong></button>
      <button type="button" data-opinion-filter="neutral"><small>中性</small><strong>${counts.neutral} 条</strong></button>
      <button type="button" data-opinion-filter="all"><small>分歧程度</small><strong>${escapeHtml(disagreement)}</strong></button>
    </div>
    <div class="summary-detail-grid">
      <div class="summary-horizons">
        ${["未来数小时", "未来数日", "中长期"].map((bucket) => {
          const item = aggregateHorizon(scoped, bucket, now, windowConfig.milliseconds);
          return `<span><small>${bucket}</small><strong class="${item.key}">${escapeHtml(item.label)}</strong></span>`;
        }).join("")}
      </div>
      <div class="summary-factors bullish"><small>主要利多主题</small><p>${bullishFactors.length ? bullishFactors.map((item) => `<span>${escapeHtml(item)}</span>`).join("") : "暂未识别明确利多主题"}</p></div>
      <div class="summary-factors bearish"><small>主要利空主题</small><p>${bearishFactors.length ? bearishFactors.map((item) => `<span>${escapeHtml(item)}</span>`).join("") : "暂未识别明确利空主题"}</p></div>
    </div>`;
}

function renderXUsage(payload) {
  const usage = payload?.usage_today || {};
  const limits = payload?.daily_limits || { posts: 20, cost_usd: 0.15 };
  const analyses = Number(usage.analyses || 0);
  const cost = Number(usage.estimated_cost_usd || 0);
  setText("x-api-post-usage", `${analyses} / ${Number(limits.posts || 20)} 条`);
  setText("x-api-cost-usage", `$${cost.toFixed(3)} / $${Number(limits.cost_usd || 0.15).toFixed(2)}`);
  if (payload?.generated_at) {
    const updatedAt = Date.parse(payload.generated_at);
    setText("x-api-connection", "X API 自动采集已启用");
    setText("x-api-updated", Number.isFinite(updatedAt) ? `数据更新于 ${formatFullTime.format(updatedAt)} CST` : "自动数据已更新");
  } else {
    setText("x-api-connection", "等待首次自动采集");
    setText("x-api-updated", "只读权限 · 不执行 X 操作");
  }
}

async function loadAutomatedOpinions() {
  try {
    const response = await fetch(`${X_POSTS_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`自动观点接口返回 ${response.status}`);
    const payload = await response.json();
    state.automatedOpinions = Array.isArray(payload.posts)
      ? payload.posts.map(normalizeAutomatedOpinion)
      : [];
    state.xUsage = payload;
    renderXUsage(payload);
    evaluateOpinions();
    renderOpinions();
  } catch (error) {
    setText("x-api-connection", "自动观点暂时无法载入");
    setText("x-api-updated", "稍后会自动重试");
  }
}

function resultMarkup(record) {
  const analysis = record.analysis;
  return `
    <div class="analysis-result-head">
      <span class="direction-badge ${analysis.direction}">${escapeHtml(analysis.directionLabel)}</span>
      <span class="analysis-confidence">置信度 ${analysis.confidence}% · 已保存到本机</span>
    </div>
    <div class="analysis-score-row">
      <div><small>情绪分数</small><strong>${analysis.directionScore > 0 ? "+" : ""}${analysis.directionScore}</strong></div>
      <div><small>预计影响面</small><strong>${escapeHtml(analysis.impact)}</strong></div>
      <div><small>主要窗口</small><strong>${escapeHtml(analysis.horizon)}</strong></div>
    </div>
    <p class="analysis-summary">${escapeHtml(analysis.summary)}</p>
    <div class="analysis-factors">${analysis.factors.map((factor) => `<span>${escapeHtml(factor)}</span>`).join("")}</div>
  `;
}

function verificationMarkup(record) {
  return OPINION_HORIZONS.map((horizon) => {
    const measurement = record.measurements?.[horizon.key];
    if (!measurement) {
      return `<span class="verification-cell"><small>${horizon.label}</small><strong>待验证</strong></span>`;
    }
    const sign = measurement.hypeReturn > 0 ? "+" : "";
    return `<span class="verification-cell ${measurement.hit ? "hit" : "miss"}"><small>${horizon.label} · ${measurement.hit ? "符合" : "偏离"}</small><strong>${sign}${measurement.hypeReturn.toFixed(2)}%</strong></span>`;
  }).join("");
}

function renderOpinions() {
  const records = allOpinions();
  renderOpinionSummary(records);
  renderFourHourBrief();
  const visibleRecords = state.opinionFilter === "all"
    ? records
    : records.filter((record) => record.analysis?.direction === state.opinionFilter);
  setText("opinion-count", state.opinionFilter === "all" ? `${records.length} 条记录` : `${visibleRecords.length} / ${records.length} 条记录`);
  const list = $("opinion-list");
  if (!visibleRecords.length) {
    list.innerHTML = `
      <div class="opinion-empty">
        <span>◎</span>
        <strong>${records.length ? "当前筛选没有对应观点" : "等待首次自动采集"}</strong>
        <p>${records.length ? "可在汇总卡片中切换其他方向。" : "X API 每 15 分钟检查一次；也可以使用上方备用入口手动添加。"}</p>
      </div>`;
    return;
  }

  list.innerHTML = visibleRecords.map((record) => {
    const analysis = record.analysis;
    const source = sourceFor(record.author);
    const baseline = record.baseline?.hype ? `基准 HYPE $${record.baseline.hype.toFixed(3)}` : "等待行情基准";
    const metrics = record.publicMetrics || {};
    const metricText = record.origin === "x-api"
      ? `<span>❤ ${Number(metrics.like_count || 0).toLocaleString("zh-CN")}</span><span>转帖 ${Number(metrics.retweet_count || 0).toLocaleString("zh-CN")}</span>`
      : "";
    const originAction = record.origin === "x-api"
      ? '<span class="auto-source-badge">X API 自动</span>'
      : `<button type="button" data-delete-opinion="${escapeHtml(record.id)}" aria-label="删除这条观点记录">删除</button>`;
    return `
      <article class="opinion-card${record.origin === "x-api" ? " automated" : ""}" data-opinion-id="${escapeHtml(record.id)}">
        <div class="opinion-card-head">
          <div class="opinion-author">
            <strong><a class="opinion-title-link" href="${escapeHtml(record.url)}" target="_blank" rel="noopener noreferrer" aria-label="在 X 打开 @${escapeHtml(record.author)} 的原帖">@${escapeHtml(record.author)} · ${escapeHtml(source.role)} ↗</a></strong>
            <span>${formatFullTime.format(record.createdAt)} 北京时间 · ${escapeHtml(baseline)}</span>
          </div>
          <div class="opinion-actions">
            <span class="direction-badge ${analysis.direction}">${escapeHtml(analysis.directionLabel)}</span>
            ${originAction}
            <a href="${escapeHtml(record.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开 X 原帖">原帖 ↗</a>
          </div>
        </div>
        <p class="opinion-excerpt">${escapeHtml(record.text)}</p>
        <p class="opinion-analysis">${escapeHtml(analysis.summary)}</p>
        <div class="opinion-meta">
          <span>置信度 ${analysis.confidence}%</span>
          <span>影响 ${escapeHtml(analysis.impact)}</span>
          <span>${escapeHtml(analysis.eventType)}</span>
          <span>${escapeHtml(analysis.horizon)}</span>
          ${metricText}
        </div>
        <div class="verification-grid" aria-label="观点发布后的 HYPE 价格验证">${verificationMarkup(record)}</div>
      </article>`;
  }).join("");
}

function findMarketRow(targetTime, horizonKey) {
  const preferredPeriods = horizonKey === "7d" ? ["1h", "4h", "15m"] : ["15m", "1h"];
  const tolerance = horizonKey === "7d" ? 2 * 60 * 60 * 1000 : horizonKey === "24h" ? 60 * 60 * 1000 : 30 * 60 * 1000;
  for (const period of preferredPeriods) {
    const rows = state.cache.get(period)?.rows;
    if (!rows?.length) continue;
    const row = rows.find((candidate) => candidate.t >= targetTime);
    if (row && Number.isFinite(row.hype) && row.t - targetTime <= tolerance) return row;
  }
  return null;
}

function marketSnapshotAt(targetTime) {
  for (const [period, tolerance] of [["15m", 45 * 60 * 1000], ["1h", 2 * 60 * 60 * 1000], ["4h", 6 * 60 * 60 * 1000]]) {
    const rows = state.cache.get(period)?.rows;
    if (!rows?.length) continue;
    let closest = null;
    for (const row of rows) {
      const distance = Math.abs(row.t - targetTime);
      if (!closest || distance < closest.distance) closest = { row, distance };
    }
    if (closest && closest.distance <= tolerance && Number.isFinite(closest.row.hype)) {
      return { t: closest.row.t, hype: closest.row.hype, eth: closest.row.eth, btc: closest.row.btc };
    }
  }
  return null;
}

function evaluateOpinions() {
  const records = allOpinions();
  if (!records.length || !state.cache.has("15m")) return;
  let changed = false;
  records.forEach((record) => {
    if (!record.baseline) {
      record.baseline = record.origin === "x-api"
        ? marketSnapshotAt(record.createdAt)
        : latestMarketSnapshot();
      changed = Boolean(record.baseline) || changed;
    }
    if (!record.baseline?.hype) return;
    record.measurements ||= {};
    OPINION_HORIZONS.forEach((horizon) => {
      if (record.measurements[horizon.key]) return;
      const targetTime = record.baseline.t + horizon.milliseconds;
      const row = findMarketRow(targetTime, horizon.key);
      if (!row) return;
      const hypeReturn = ((row.hype / record.baseline.hype) - 1) * 100;
      const direction = record.analysis.direction;
      const hit = direction === "bullish" ? hypeReturn > 0 : direction === "bearish" ? hypeReturn < 0 : Math.abs(hypeReturn) < 0.75;
      record.measurements[horizon.key] = {
        measuredAt: row.t,
        hypeReturn,
        ethRatioChange: ((row.eth / record.baseline.eth) - 1) * 100,
        btcRatioChange: ((row.btc / record.baseline.btc) - 1) * 100,
        hit,
      };
      changed = true;
    });
  });
  if (changed) {
    saveOpinions();
    renderOpinions();
  }
}

function timelineFallback(source) {
  const frame = $("timeline-frame");
  if (state.activeSocialSource !== source.handle || frame.querySelector("iframe")) return;
  frame.innerHTML = `
    <div class="timeline-fallback">
      <strong>当前网络没有载入 X 时间线</strong>
      <p>部分网络或隐私设置会阻止第三方嵌入。可以直接打开账号查看最新帖子，再把链接和正文粘贴到右侧分析。</p>
      <a href="https://x.com/${encodeURIComponent(source.handle)}" target="_blank" rel="noopener noreferrer">打开 @${escapeHtml(source.handle)} ↗</a>
    </div>`;
}

function renderTimeline(handle) {
  const source = sourceFor(handle);
  state.activeSocialSource = source.handle;
  document.querySelectorAll(".source-tab").forEach((button) => {
    const active = button.dataset.handle === source.handle;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const profileUrl = `https://x.com/${source.handle}`;
  const profileLink = $("active-x-profile");
  profileLink.href = profileUrl;
  const frame = $("timeline-frame");
  frame.innerHTML = `<a class="twitter-timeline" data-theme="dark" data-height="600" data-chrome="noheader nofooter noborders transparent" data-dnt="true" href="${profileUrl}">正在载入 @${escapeHtml(source.handle)} 的官方 X 时间线…</a>`;

  let attempts = 0;
  const loadWidget = () => {
    if (state.activeSocialSource !== source.handle) return;
    if (window.twttr?.widgets?.load) {
      Promise.resolve(window.twttr.widgets.load(frame)).catch(() => timelineFallback(source));
      window.setTimeout(() => timelineFallback(source), 12_000);
      return;
    }
    attempts += 1;
    if (attempts < 24) window.setTimeout(loadWidget, 400);
    else timelineFallback(source);
  };
  loadWidget();
}

function initSocial() {
  const tabs = $("source-tabs");
  tabs.innerHTML = SOCIAL_SOURCES.map((source, index) => `
    <button class="source-tab${index === 0 ? " active" : ""}" type="button" role="tab" aria-selected="${index === 0}" data-handle="${escapeHtml(source.handle)}">
      <span class="source-avatar">${escapeHtml(source.name.slice(0, 1).toUpperCase())}</span>
      <strong>@${escapeHtml(source.handle)}</strong>
      <small>${escapeHtml(source.role)}</small>
    </button>`).join("");
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-handle]");
    if (button) renderTimeline(button.dataset.handle);
  });

  const authorSelect = $("opinion-author");
  authorSelect.innerHTML = SOCIAL_SOURCES.map((source) => `<option value="${escapeHtml(source.handle)}">@${escapeHtml(source.handle)} · ${escapeHtml(source.role)}</option>`).join("") + '<option value="other">其他账号</option>';

  $("opinion-url").addEventListener("change", (event) => {
    const parsed = parseXPostUrl(event.target.value);
    if (!parsed) return;
    const known = SOCIAL_SOURCES.find((source) => source.handle.toLowerCase() === parsed.handle.toLowerCase());
    authorSelect.value = known?.handle || "other";
  });

  $("opinion-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = parseXPostUrl($("opinion-url").value.trim());
    if (!parsed) {
      showToast("请输入有效的 X 帖子链接，例如 https://x.com/账号/status/数字");
      return;
    }
    const text = $("opinion-text").value.trim();
    if (text.length < 12) {
      showToast("帖子正文太短，至少需要 12 个字符才能判断");
      return;
    }
    const selectedAuthor = authorSelect.value === "other" ? parsed.handle : authorSelect.value;
    const analysis = analyzeOpinion(text, selectedAuthor);
    const publishedAt = xSnowflakeTimestamp(parsed.postId);
    const record = {
      id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      author: selectedAuthor,
      postId: parsed.postId,
      url: parsed.url,
      text,
      analysis,
      origin: "manual",
      baseline: latestMarketSnapshot(),
      measurements: {},
    };
    state.opinions.unshift(record);
    state.opinions = state.opinions.slice(0, 50);
    saveOpinions();
    renderOpinions();
    const result = $("analysis-result");
    result.innerHTML = resultMarkup(record);
    result.hidden = false;
    showToast("观点已加入验证记录");
  });

  $("opinion-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-opinion]");
    if (!button) return;
    state.opinions = state.opinions.filter((record) => record.id !== button.dataset.deleteOpinion);
    saveOpinions();
    renderOpinions();
    showToast("观点记录已从本机删除");
  });

  $("opinion-summary").addEventListener("click", (event) => {
    const windowButton = event.target.closest("[data-summary-window]");
    if (windowButton) {
      state.summaryWindow = windowButton.dataset.summaryWindow;
      renderOpinions();
      return;
    }
    const filterButton = event.target.closest("[data-opinion-filter]");
    if (filterButton) {
      state.opinionFilter = filterButton.dataset.opinionFilter;
      renderOpinions();
    }
  });

  state.opinions = readOpinions();
  renderOpinions();
  renderTimeline(SOCIAL_SOURCES[0].handle);
  loadAutomatedOpinions();
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => switchPeriod(button.dataset.period));
});
$("refresh-button").addEventListener("click", () => refreshAll(true));

window.addEventListener("online", () => {
  setConnection("online", "网络已恢复");
  refreshAll(true);
});
window.addEventListener("offline", () => setConnection("error", "网络离线"));

initSocial();
refreshAll();
window.setInterval(() => refreshAll(true), 5 * 60 * 1000);
window.setInterval(loadAutomatedOpinions, 5 * 60 * 1000);
