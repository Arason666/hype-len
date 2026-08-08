const API_URL = "https://api.hyperliquid.xyz/info";
const DAY = 24 * 60 * 60 * 1000;
const PERIODS = {
  "15m": { interval: "15m", lookback: 7 * DAY, label: "最近 7 天" },
  "1h": { interval: "1h", lookback: 30 * DAY, label: "最近 30 天" },
  "4h": { interval: "4h", lookback: 90 * DAY, label: "最近 90 天" },
  "1d": { interval: "1d", lookback: 365 * DAY, label: "最近 1 年" },
};
const PERIOD_ORDER = ["15m", "1h", "4h", "1d"];
const CACHE_PREFIX = "hype-lens-v1-";

const state = {
  activePeriod: "15m",
  cache: new Map(),
  loading: false,
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

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => switchPeriod(button.dataset.period));
});
$("refresh-button").addEventListener("click", () => refreshAll(true));

window.addEventListener("online", () => {
  setConnection("online", "网络已恢复");
  refreshAll(true);
});
window.addEventListener("offline", () => setConnection("error", "网络离线"));

refreshAll();
window.setInterval(() => refreshAll(true), 5 * 60 * 1000);
