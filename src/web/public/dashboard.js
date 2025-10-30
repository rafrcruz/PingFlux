const CONFIG = window.UI_CONFIG ?? {};
const STRINGS = window.UI_STRINGS ?? {};

const SPARKLINE_EWMA_ALPHA = (() => {
  const raw = CONFIG.UI_EWMA_ALPHA ?? CONFIG.uiEwmaAlpha;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 && num < 1 ? num : null;
})();

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const LIVE_ENDPOINTS = ["/v1/live/metrics", "/live/metrics"];
const API_PING_WINDOW = ["/v1/api/ping/window", "/api/ping/window"];
const API_TRACEROUTE_LATEST = ["/v1/api/traceroute/latest", "/api/traceroute/latest"];
const API_TRACEROUTE_BY_ID = (id) => [`/v1/api/traceroute/${id}`, `/api/traceroute/${id}`];

const DEFAULT_TARGET =
  typeof CONFIG.DEFAULT_TARGET === "string"
    ? CONFIG.DEFAULT_TARGET
    : typeof CONFIG.defaultTarget === "string"
      ? CONFIG.defaultTarget
      : "";
const EVENTS_DEDUP_MS = toPositiveInt(CONFIG.EVENTS_DEDUP_MS ?? CONFIG.eventsDedupMs, 30000);
const EVENTS_COOLDOWN_MS = toPositiveInt(
  CONFIG.EVENTS_COOLDOWN_MS ?? CONFIG.eventsCooldownMs,
  10000
);
const TRACEROUTE_MAX_AGE_MIN = toPositiveInt(
  CONFIG.TRACEROUTE_MAX_AGE_MIN ?? CONFIG.tracerouteMaxAgeMin,
  10
);
const EVENTS_LIMIT = 50;

const LIVE_INACTIVITY_TIMEOUT_MS = toPositiveInt(
  CONFIG.LIVE_INACTIVITY_TIMEOUT_MS ?? CONFIG.liveInactivityTimeoutMs,
  15000
);

const RANGE_OPTIONS = [1, 5, 15, 60];
const WINDOW_OPTION_MAP = new Map(
  RANGE_OPTIONS.map((minutes) => [minutes, minutes === 60 ? "60m" : `${minutes}m`])
);
const MAX_RANGE_MINUTES = RANGE_OPTIONS.reduce((max, value) => (value > max ? value : max), 60);
const HISTORY_LIMIT_MS = MAX_RANGE_MINUTES * 60 * 1000;
const DNS_HISTORY_LIMIT_MS = 60 * 60 * 1000;
const MIN_WINDOW_SAMPLES = 3;

const thresholds = CONFIG.thresholds ?? {};
const HEATMAP_ENABLED = Boolean(CONFIG.UI_ENABLE_HEATMAP);
const initialViewportWidth =
  typeof window !== "undefined"
    ? window.innerWidth || document.documentElement.clientWidth || 0
    : 0;

function getWindowKeyFromMinutes(minutes) {
  const normalized = Number(minutes);
  return WINDOW_OPTION_MAP.get(normalized) ?? "1m";
}

function getRangeParamFromMinutes(minutes) {
  const normalized = Number(minutes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "1m";
  }
  return normalized === 60 ? "60m" : `${normalized}m`;
}

function formatWindowLabel(minutes) {
  const normalized = Number(minutes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "1m";
  }
  return `${normalized}m`;
}

function getWindowKeyFromRange(range) {
  if (typeof range !== "string") {
    return "1m";
  }
  const normalized = range.trim().toLowerCase();
  if (normalized === "60m" || normalized === "1h") {
    return "60m";
  }
  if (normalized === "15m") {
    return "15m";
  }
  if (normalized === "5m") {
    return "5m";
  }
  return "1m";
}

const severityRank = { info: 0, warn: 1, critical: 2 };
const HEAT_BUCKETS = [0, 50, 100, 150, 200, 300, 500, 800, 1200];
const HEAT_LABELS = [
  "<50 ms",
  "50-100 ms",
  "100-150 ms",
  "150-200 ms",
  "200-300 ms",
  "300-500 ms",
  "500-800 ms",
  "800-1200 ms",
  ">1200 ms",
];

const state = {
  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  connection: "connecting",
  connectedEndpointIndex: 0,
  reconnectAttempts: 0,
  lastUpdateTs: null,
  targets: [],
  selectedTarget: DEFAULT_TARGET || "",
  rangeMinutes: RANGE_OPTIONS[0],
  pingAggregates: new Map(),
  pingSamples: new Map(),
  windowSummaries: new Map(),
  latestSampleTs: new Map(),
  dnsSeries: [],
  dnsLatest: null,
  httpTtfbSeries: [],
  httpTotalSeries: [],
  httpLatest: { ttfb: null, total: null },
  trends: new Map(),
  severities: new Map(),
  prevValues: new Map(),
  events: [],
  eventKeyIndex: new Map(),
  eventTypeIndex: new Map(),
  traceroute: null,
  tracerouteLoading: false,
  tracerouteExpanded: false,
  targetIndicators: new Map(),
  viewportWidth: initialViewportWidth,
  compactMode: initialViewportWidth > 0 && initialViewportWidth < 1024,
};

const refs = {
  themeToggle: document.getElementById("themeToggle"),
  connectionDot: document.getElementById("connectionDot"),
  connectionText: document.getElementById("connectionText"),
  lastUpdate: document.getElementById("lastUpdate"),
  targetSelect: document.getElementById("targetSelect"),
  targetMode: document.getElementById("pingModeIndicator"),
  rangeButtons: document.getElementById("rangeButtons"),
  resetZoom: document.getElementById("resetZoom"),
  eventList: document.getElementById("eventList"),
  tracerouteTimeline: document.getElementById("tracerouteTimeline"),
  tracerouteMeta: document.getElementById("tracerouteMeta"),
  tracerouteTrigger: document.getElementById("tracerouteTrigger"),
  networkStatusBar: document.getElementById("networkStatusBar"),
  networkStatusText: document.getElementById("networkStatusText"),
  heatmapPanel: document.querySelector("[data-heatmap-panel]"),
  traceroutePanel: document.querySelector(".panel-traceroute"),
};

const windowLabelRefs = new Map();
document.querySelectorAll("[data-window-label]").forEach((node) => {
  const key = node.getAttribute("data-window-label");
  if (key) {
    windowLabelRefs.set(key, node);
  }
});

function getViewportWidth() {
  return typeof window !== "undefined"
    ? window.innerWidth || document.documentElement.clientWidth || 0
    : state.viewportWidth;
}

function updatePanelVisibility() {
  if (refs.heatmapPanel) {
    refs.heatmapPanel.hidden = !HEATMAP_ENABLED || state.compactMode;
  }
  if (refs.traceroutePanel) {
    refs.traceroutePanel.hidden = state.compactMode;
  }
}

function bootstrapLayout() {
  state.viewportWidth = getViewportWidth();
  state.compactMode = state.viewportWidth > 0 && state.viewportWidth < 1024;
  const isMedium = !state.compactMode && state.viewportWidth < 1280;
  document.body.classList.toggle("is-compact", state.compactMode);
  document.body.classList.toggle("is-medium", isMedium);
  updatePanelVisibility();
}

let resizeFrame = null;

function updateLayoutClasses() {
  const width = getViewportWidth();
  const wasCompact = state.compactMode;
  state.viewportWidth = width;
  state.compactMode = width > 0 && width < 1024;
  const isMedium = !state.compactMode && width < 1280;
  document.body.classList.toggle("is-compact", state.compactMode);
  document.body.classList.toggle("is-medium", isMedium);
  updatePanelVisibility();
  if (wasCompact !== state.compactMode) {
    configureGauges();
    refreshGaugeValues();
  }
  if (wasCompact !== state.compactMode) {
    renderHeatmap();
    renderTraceroute();
  }
  resizeCharts();
}

function handleResize() {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    updateLayoutClasses();
  });
}

const kpiCards = Array.from(document.querySelectorAll(".kpi-card")).map((card) => {
  const key = card.getAttribute("data-kpi");
  return {
    key,
    element: card,
    valueEl: card.querySelector("[data-value]"),
    trendEl: card.querySelector(".trend-label"),
    arrowEl: card.querySelector(".trend-arrow"),
  };
});

const charts = {
  latency: null,
  heatmap: null,
  availability: null,
  dnsGauge: null,
  httpGauge: null,
  httpTtfb: null,
};

const chartOverlays = new Map();

function normalize(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getCssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    const trimmed = value != null ? value.trim() : "";
    return trimmed || fallback;
  } catch (error) {
    return fallback;
  }
}

const numberFormatters = new Map();

function getNumberFormatter(digits) {
  const key = Math.max(0, digits);
  if (!numberFormatters.has(key)) {
    numberFormatters.set(
      key,
      new Intl.NumberFormat("pt-BR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: key,
      })
    );
  }
  return numberFormatters.get(key);
}

function fmtNumber(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "—";
  }
  const abs = Math.abs(num);
  let decimals = Math.max(0, Math.floor(digits));
  if (abs >= 1000) {
    decimals = 0;
  } else if (abs >= 100) {
    decimals = Math.min(decimals, 0);
  } else if (abs >= 10) {
    decimals = Math.min(decimals, Math.max(1, decimals));
  } else if (abs >= 1) {
    decimals = Math.min(Math.max(decimals, 1), 2);
  } else {
    decimals = Math.min(Math.max(decimals, 2), 3);
  }
  return getNumberFormatter(decimals).format(num);
}

function fmtMs(value, digits = 1) {
  const text = fmtNumber(value, digits);
  return text === "—" ? text : `${text} ms`;
}

function fmtPct(value, digits = 1) {
  const text = fmtNumber(value, digits);
  return text === "—" ? text : `${text}%`;
}

function formatTime(ts) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));
  } catch (error) {
    return new Date(ts).toLocaleTimeString();
  }
}

let eventSource = null;
let reconnectTimer = null;
let renderScheduled = false;
let heatmapNeedsRefresh = false;
let eventsRefreshTimer = null;
let liveInactivityTimer = null;

init();

function init() {
  applyTooltips();
  mountTheme();
  mountRangeButtons();
  mountControls();
  bootstrapLayout();
  applyHeatmapVisibility();
  initChartOverlays();
  initCharts();
  updateLayoutClasses();
  openLiveStream();
  if (state.selectedTarget) {
    bootstrapTargetData(state.selectedTarget).catch(() => {});
    fetchTraceroute(state.selectedTarget).catch(() => {});
  }
  scheduleRender();
  updateNetworkStatus();
  startEventsRefreshTimer();
  window.addEventListener("resize", handleResize);
}

function applyTooltips() {
  document.querySelectorAll("[data-tooltip]").forEach((button) => {
    const key = button.getAttribute("data-tooltip");
    if (key && STRINGS[key]) {
      button.setAttribute("title", STRINGS[key]);
    }
  });
}

function applyHeatmapVisibility() {
  if (!refs.heatmapPanel) {
    return;
  }
  refs.heatmapPanel.hidden = !HEATMAP_ENABLED || state.compactMode;
}

function initChartOverlays() {
  [
    "latencyChart",
    "heatmapChart",
    "dnsGauge",
    "httpTtfbSparkline",
    "httpGauge",
  ].forEach((id) => ensureChartOverlay(id));
}

function ensureChartOverlay(id) {
  if (chartOverlays.has(id)) {
    return;
  }
  const host = document.getElementById(id);
  if (!host) {
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "chart-empty-overlay";
  overlay.textContent = "Sem dados no período";
  overlay.setAttribute("role", "status");
  overlay.hidden = true;
  host.appendChild(overlay);
  chartOverlays.set(id, overlay);
}

function setChartEmptyState(id, empty) {
  const overlay = chartOverlays.get(id);
  if (!overlay) {
    return;
  }
  overlay.hidden = !empty;
  if (empty) {
    overlay.setAttribute("aria-hidden", "false");
  } else {
    overlay.setAttribute("aria-hidden", "true");
  }
}

function mountTheme() {
  updateThemeClass();
  refs.themeToggle?.addEventListener("click", () => {
    const next = state.theme === "dark" ? "light" : "dark";
    state.theme = next;
    updateThemeClass();
    try {
      localStorage.setItem("pingflux-theme", next);
    } catch (error) {
      // Ignore storage errors.
    }
    configureGauges();
    refreshGaugeValues();
    resizeCharts();
  });
}

function updateThemeClass() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(`theme-${state.theme}`);
}

function mountRangeButtons() {
  if (!refs.rangeButtons) {
    return;
  }
  refs.rangeButtons.innerHTML = "";
  RANGE_OPTIONS.forEach((minutes) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${minutes}m`;
    button.setAttribute("aria-pressed", minutes === state.rangeMinutes ? "true" : "false");
    button.addEventListener("click", () => {
      if (state.rangeMinutes === minutes) {
        return;
      }
      state.rangeMinutes = minutes;
      updateWindowLabels();
      Array.from(refs.rangeButtons.querySelectorAll("button")).forEach((btn) => {
        btn.setAttribute("aria-pressed", btn === button ? "true" : "false");
      });
      onWindowRangeChanged().catch(() => {});
    });
    refs.rangeButtons.appendChild(button);
  });
  updateWindowLabels();
}

function updateWindowLabels() {
  const label = formatWindowLabel(state.rangeMinutes);
  windowLabelRefs.forEach((node) => {
    if (node) {
      node.textContent = `Janela atual · ${label}`;
    }
  });
}

function mountControls() {
  refs.targetSelect?.addEventListener("change", () => {
    const value = refs.targetSelect.value;
    if (value && value !== state.selectedTarget) {
      state.selectedTarget = value;
      state.tracerouteExpanded = false;
      bootstrapTargetData(value).catch(() => {});
      fetchTraceroute(value).catch(() => {});
      scheduleRender();
      updateTargetStatusDisplay();
    }
  });

  refs.resetZoom?.addEventListener("click", () => {
    charts.latency?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  });

  refs.tracerouteTrigger?.addEventListener("click", () => {
    if (!state.selectedTarget || state.tracerouteLoading) {
      return;
    }
    triggerTraceroute(state.selectedTarget).catch(() => {});
  });
}

async function onWindowRangeChanged() {
  const target = state.selectedTarget;
  if (target) {
    const rangeParam = getRangeParamFromMinutes(state.rangeMinutes);
    try {
      await fetchPingWindowData(target, rangeParam, { mergeSamples: true, updateVisibleSummary: true });
    } catch (error) {
      console.error("Falha ao atualizar janela visual:", error);
    }
  }
  updateDnsKpi();
  scheduleRender();
  updateNetworkStatus();
}

async function bootstrapTargetData(target) {
  if (!target) {
    return;
  }
  try {
    await fetchPingWindowData(target, "60m", { mergeSamples: false });
    await fetchPingWindowData(target, getRangeParamFromMinutes(state.rangeMinutes), {
      mergeSamples: true,
      updateVisibleSummary: true,
    });
  } finally {
    updateDnsKpi();
  }
}
function initCharts() {
  if (typeof echarts === "undefined") {
    console.error("ECharts não carregado");
    return;
  }
  charts.latency = echarts.init(document.getElementById("latencyChart"), null, {
    renderer: "canvas",
  });
  const heatmapHost = document.getElementById("heatmapChart");
  charts.heatmap = HEATMAP_ENABLED && heatmapHost ? echarts.init(heatmapHost, null, { renderer: "canvas" }) : null;
  charts.availability = echarts.init(document.getElementById("availabilityGauge"), null, {
    renderer: "canvas",
  });
  charts.dnsGauge = echarts.init(document.getElementById("dnsGauge"), null, { renderer: "canvas" });
  charts.httpGauge = echarts.init(document.getElementById("httpGauge"), null, { renderer: "canvas" });
  charts.httpTtfb = echarts.init(document.getElementById("httpTtfbSparkline"), null, {
    renderer: "canvas",
  });

  configureLatencyChart();
  if (HEATMAP_ENABLED) {
    configureHeatmap();
  }
  configureGauges();
  configureSparkline(charts.httpTtfb, "#f97316");
}

function configureLatencyChart() {
  if (!charts.latency) {
    return;
  }
  const legendColor = getCssVar("--text-muted", "#cbd5f5");
  const axisLabelColor = getCssVar("--chart-axis-label", "rgba(226, 232, 240, 0.92)");
  const axisLineColor = getCssVar("--chart-axis-line", "rgba(148, 163, 184, 0.45)");
  const gridLineColor = getCssVar("--chart-grid-line", "rgba(148, 163, 184, 0.24)");
  charts.latency.setOption({
    backgroundColor: "transparent",
    animationDuration: 260,
    legend: {
      bottom: 0,
      textStyle: {
        color: legendColor,
        fontSize: 11,
      },
      data: ["RTT por amostra", "Perda"],
    },
    grid: { left: 52, right: 32, top: 40, bottom: 70, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: axisLineColor, width: 1.2 } },
      backgroundColor: "rgba(15, 23, 42, 0.88)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
      formatter: (params) => {
        if (!params || params.length === 0) {
          return STRINGS.noData || "Sem dados suficientes no período.";
        }
        const lines = [];
        const axisLabel = params[0]?.axisValueLabel;
        if (axisLabel) {
          lines.push(axisLabel);
        }
        params.forEach((serie) => {
          if (!serie) {
            return;
          }
          if (serie.seriesName === "Perda") {
            lines.push(`${serie.marker} Perda de pacote`);
            return;
          }
          const value = Array.isArray(serie.value) ? serie.value[1] : serie.value;
          if (Number.isFinite(value)) {
            lines.push(`${serie.marker} RTT: ${fmtMs(value)}`);
          }
        });
        if (lines.length === (axisLabel ? 1 : 0)) {
          return STRINGS.noData || "Sem dados suficientes no período.";
        }
        return lines.join("<br />");
      },
    },
    dataZoom: [
      { type: "inside", throttle: 50 },
      { type: "slider", bottom: 24, textStyle: { color: "#94a3b8" } },
    ],
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: { color: axisLabelColor, hideOverlap: true, fontSize: 11 },
      splitNumber: 6,
      splitLine: { lineStyle: { color: gridLineColor } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "ms",
      min: 0,
      splitNumber: 6,
      nameTextStyle: { color: axisLabelColor, fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: axisLineColor } },
      axisLabel: {
        color: axisLabelColor,
        fontSize: 11,
        formatter: (value) => (Number.isFinite(value) ? `${fmtNumber(value, 1)} ms` : value),
      },
      splitLine: { lineStyle: { color: gridLineColor } },
    },
    series: [
      {
        name: "RTT por amostra",
        type: "line",
        step: false,
        showSymbol: true,
        symbol: "circle",
        symbolSize: 6,
        smooth: 0.35,
        connectNulls: false,
        lineStyle: { width: 2, color: "#38bdf8" },
        itemStyle: { color: "#38bdf8", borderColor: "#0ea5e9", borderWidth: 1.5 },
        emphasis: { focus: "series", scale: 1.3 },
        data: [],
      },
      {
        name: "Perda",
        type: "scatter",
        symbol: "triangle",
        symbolSize: 12,
        symbolRotate: 180,
        itemStyle: { color: "#f87171", borderColor: "#fecaca", borderWidth: 1 },
        data: [],
      },
    ],
  });
}

function configureHeatmap() {
  if (!charts.heatmap) {
    return;
  }
  charts.heatmap.setOption({
    tooltip: {
      formatter: (params) => {
        if (!params || params.value == null) {
          return STRINGS.noData || "Sem dados suficientes no período.";
        }
        const [ts, , value, count] = params.value;
        return `${formatTime(ts)}<br/>p95: ${fmtMs(value)}<br/>Amostras: ${count ?? "n/d"}`;
      },
      backgroundColor: "rgba(15, 23, 42, 0.88)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
    },
    grid: { left: 60, right: 24, bottom: 48, top: 30, containLabel: true },
    xAxis: {
      type: "time",
      axisLabel: { color: "var(--text-muted)", fontSize: 11, hideOverlap: true },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.25)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      data: HEAT_LABELS,
      axisLabel: { color: "var(--text-muted)", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.25)" } },
      splitLine: { show: false },
    },
    visualMap: {
      min: 0,
      max: 1200,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: {
        color: ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444"],
      },
      textStyle: { color: "var(--text-muted)" },
    },
    series: [
      {
        type: "heatmap",
        data: [],
        progressive: 400,
        emphasis: { focus: "series" },
      },
    ],
  });
}

const GAUGE_COLOR_OK = "#3fb950";
const GAUGE_COLOR_WARN = "#d29922";
const GAUGE_COLOR_CRIT = "#f85149";
const GAUGE_COLOR_NEUTRAL = "#64748b";

function configureGauges() {
  const labelColor = getCssVar("--text-muted", "#94a3b8");
  const detailColor = getCssVar("--text-base", "#e6edf3");
  const tickColor = "rgba(148, 163, 184, 0.35)";
  const splitColor = "rgba(148, 163, 184, 0.45)";
  const axisWidth = state.compactMode ? 14 : 18;
  const tickLength = state.compactMode ? 5 : 8;
  const splitLength = state.compactMode ? 10 : 14;
  const labelDistance = state.compactMode ? 8 : 12;
  const detailFontSize = state.compactMode ? 22 : 30;
  const pointerWidth = state.compactMode ? 4 : 6;
  const anchorSize = state.compactMode ? 6 : 8;
  const anchorColor = getCssVar("--chart-anchor", "#0f172a");

  const baseSeries = {
    type: "gauge",
    startAngle: 225,
    endAngle: -45,
    min: 0,
    max: 100,
    splitNumber: 10,
    progress: { show: false },
    axisLine: { lineStyle: { width: axisWidth, color: [[1, GAUGE_COLOR_OK]] } },
    axisTick: { length: tickLength, distance: 0, lineStyle: { color: tickColor, width: 1 } },
    splitLine: { length: splitLength, distance: 0, lineStyle: { color: splitColor, width: 2 } },
    axisLabel: { color: labelColor, distance: labelDistance, fontSize: state.compactMode ? 10 : 12 },
    pointer: { show: true, length: "70%", width: pointerWidth, itemStyle: { color: GAUGE_COLOR_OK } },
    anchor: { show: true, showAbove: true, size: anchorSize, itemStyle: { color: anchorColor } },
    detail: {
      fontSize: detailFontSize,
      fontWeight: 600,
      color: detailColor,
      offsetCenter: [0, "50%"],
      valueAnimation: true,
      formatter: () => "—",
    },
    title: { show: false },
    data: [{ value: 0 }],
  };

  if (charts.availability) {
    charts.availability.setOption({
      animationDuration: 240,
      series: [
        {
          ...baseSeries,
          min: 0,
          max: 100,
          splitNumber: 10,
          axisLabel: { ...baseSeries.axisLabel, formatter: (val) => `${Math.round(val)}%` },
        },
      ],
    });
  }
  if (charts.dnsGauge) {
    charts.dnsGauge.setOption({
      animationDuration: 240,
      series: [
        {
          ...baseSeries,
          min: 0,
          max: 500,
          splitNumber: 5,
          axisLabel: { ...baseSeries.axisLabel, formatter: (val) => `${Math.round(val)} ms` },
        },
      ],
    });
  }
  if (charts.httpGauge) {
    charts.httpGauge.setOption({
      animationDuration: 240,
      series: [
        {
          ...baseSeries,
          min: 0,
          max: 3000,
          splitNumber: 5,
          axisLabel: { ...baseSeries.axisLabel, formatter: (val) => `${Math.round(val)} ms` },
        },
      ],
    });
  }

  refreshGaugeValues();
}

function refreshGaugeValues() {
  updateAvailabilityGauge(getAvailabilityGaugeValue());
  updateDnsGauge(getDnsGaugeValue());
  updateHttpGauge(getHttpGaugeValue());
}

function getAvailabilityGaugeValue() {
  const target = state.selectedTarget;
  if (!target) {
    return null;
  }
  const summaries = state.windowSummaries.get(target);
  const summary = summaries ? summaries.get("1m") : null;
  if (!summary) {
    return null;
  }
  const availability = normalize(summary.win_availability_pct);
  if (availability != null) {
    return clampGaugeValue(availability);
  }
  const loss = normalize(summary.win_loss_pct);
  return loss == null ? null : clampGaugeValue(100 - loss);
}

function getDnsGaugeValue() {
  const stats = selectDnsPrimaryStats(state.dnsLatest);
  return stats ? normalize(stats.win1m_avg_ms) : null;
}

function getHttpGaugeValue() {
  return normalize(state.httpLatest?.total);
}

function updateAvailabilityGauge(value) {
  if (!charts.availability) {
    return;
  }
  const numeric = Number.isFinite(value) ? clampGaugeValue(value) : null;
  const threshold = thresholds.loss;
  const pointerColor = numeric == null ? GAUGE_COLOR_NEUTRAL : resolveGaugeSeverityColor(numeric, threshold, false);
  const axisColors = buildGaugeAxisColors({ min: 0, max: 100, threshold, higherIsBad: false });
  charts.availability.setOption({
    series: [
      {
        min: 0,
        max: 100,
        splitNumber: 10,
        axisLine: { lineStyle: { color: axisColors } },
        pointer: { show: numeric != null, itemStyle: { color: pointerColor } },
        detail: {
          color: numeric == null ? getCssVar("--text-muted", "#94a3b8") : pointerColor,
          formatter: () => (numeric == null ? "—" : fmtPct(numeric)),
        },
        data: [{ value: numeric ?? 0 }],
      },
    ],
  });
  setChartEmptyState("availabilityGauge", numeric == null);
}

function updateDnsGauge(value) {
  if (!charts.dnsGauge) {
    return;
  }
  const numeric = clampMsValue(value);
  const threshold = thresholds.dns;
  const candidates = [numeric, normalize(threshold?.warn), normalize(threshold?.crit)];
  const max = computeDynamicGaugeMax(state.dnsSeries, {
    fallback: 200,
    min: 100,
    max: 1000,
    include: candidates,
  });
  const pointerColor = numeric == null ? GAUGE_COLOR_NEUTRAL : resolveGaugeSeverityColor(numeric, threshold, true);
  const axisColors = buildGaugeAxisColors({ min: 0, max, threshold, higherIsBad: true });
  charts.dnsGauge.setOption({
    series: [
      {
        min: 0,
        max,
        splitNumber: 5,
        axisLabel: { formatter: (val) => `${Math.round(val)} ms` },
        axisLine: { lineStyle: { color: axisColors } },
        pointer: { show: numeric != null, itemStyle: { color: pointerColor } },
        detail: {
          color: numeric == null ? getCssVar("--text-muted", "#94a3b8") : pointerColor,
          formatter: () => (numeric == null ? "—" : fmtMs(numeric)),
        },
        data: [{ value: numeric == null ? 0 : Math.min(numeric, max) }],
      },
    ],
  });
  setChartEmptyState("dnsGauge", numeric == null);
}

function updateHttpGauge(value) {
  if (!charts.httpGauge) {
    return;
  }
  const numeric = clampMsValue(value);
  const threshold = thresholds.ttfb;
  const candidates = [numeric, normalize(threshold?.warn), normalize(threshold?.crit)];
  const max = computeDynamicGaugeMax(state.httpTotalSeries, {
    fallback: 800,
    min: 200,
    max: 3000,
    include: candidates,
  });
  const pointerColor = numeric == null ? GAUGE_COLOR_NEUTRAL : resolveGaugeSeverityColor(numeric, threshold, true);
  const axisColors = buildGaugeAxisColors({ min: 0, max, threshold, higherIsBad: true });
  charts.httpGauge.setOption({
    series: [
      {
        min: 0,
        max,
        splitNumber: 5,
        axisLabel: { formatter: (val) => `${Math.round(val)} ms` },
        axisLine: { lineStyle: { color: axisColors } },
        pointer: { show: numeric != null, itemStyle: { color: pointerColor } },
        detail: {
          color: numeric == null ? getCssVar("--text-muted", "#94a3b8") : pointerColor,
          formatter: () => (numeric == null ? "—" : fmtMs(numeric)),
        },
        data: [{ value: numeric == null ? 0 : Math.min(numeric, max) }],
      },
    ],
  });
  setChartEmptyState("httpGauge", numeric == null);
}

function resolveGaugeSeverityColor(value, threshold, higherIsBad) {
  if (value == null || !Number.isFinite(value)) {
    return GAUGE_COLOR_NEUTRAL;
  }
  const severity = determineSeverity(value, threshold, higherIsBad !== false);
  if (severity === "critical") {
    return GAUGE_COLOR_CRIT;
  }
  if (severity === "warn") {
    return GAUGE_COLOR_WARN;
  }
  return GAUGE_COLOR_OK;
}

function buildGaugeAxisColors({ min, max, threshold, higherIsBad }) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 1;
  const range = safeMax - safeMin;
  const clampRatio = (value) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    const ratio = (value - safeMin) / range;
    return Math.max(0, Math.min(1, ratio));
  };

  if (!threshold) {
    return [[1, GAUGE_COLOR_OK]];
  }

  if (higherIsBad === false) {
    const warn = Number(threshold.warn);
    const crit = Number(threshold.crit);
    const warnValue = Number.isFinite(warn) ? clampGaugeValue(100 - warn) : null;
    const critValue = Number.isFinite(crit) ? clampGaugeValue(100 - crit) : null;
    const critRatio = clampRatio(critValue);
    const warnRatio = clampRatio(warnValue);
    const colors = [];
    if (critRatio != null) {
      colors.push([critRatio, GAUGE_COLOR_CRIT]);
    }
    if (warnRatio != null && (critRatio == null || warnRatio > critRatio)) {
      colors.push([warnRatio, GAUGE_COLOR_WARN]);
    }
    colors.push([1, GAUGE_COLOR_OK]);
    return colors;
  }

  const warn = Number(threshold.warn);
  const crit = Number(threshold.crit);
  const warnRatio = clampRatio(warn);
  const critRatio = clampRatio(crit);
  const segments = [];
  if (warnRatio != null && warnRatio > 0) {
    segments.push([Math.min(warnRatio, 1), GAUGE_COLOR_OK]);
  }
  if (critRatio != null) {
    const previousRatio = segments.length ? segments[segments.length - 1][0] : 0;
    const midColor = warnRatio != null ? GAUGE_COLOR_WARN : GAUGE_COLOR_OK;
    const effectiveCrit = Math.min(Math.max(critRatio, previousRatio), 1);
    if (effectiveCrit > previousRatio) {
      segments.push([effectiveCrit, midColor]);
    } else if (!segments.length) {
      segments.push([effectiveCrit, midColor]);
    }
    segments.push([1, GAUGE_COLOR_CRIT]);
    return segments;
  }
  if (segments.length) {
    segments.push([1, GAUGE_COLOR_WARN]);
  } else {
    segments.push([1, GAUGE_COLOR_OK]);
  }
  return segments;
}

function computeDynamicGaugeMax(series, options = {}) {
  const fallback = Number.isFinite(options.fallback) ? options.fallback : 100;
  const min = Number.isFinite(options.min) ? options.min : 50;
  const maxCap = Number.isFinite(options.max) ? options.max : 2000;
  const include = Array.isArray(options.include) ? options.include : [];

  const values = [];
  if (Array.isArray(series)) {
    series.forEach((item) => {
      const value = normalize(item?.value ?? item?.val ?? item);
      if (Number.isFinite(value) && value >= 0) {
        values.push(value);
      }
    });
  }
  include.forEach((candidate) => {
    const normalized = normalize(candidate);
    if (Number.isFinite(normalized) && normalized >= 0) {
      values.push(normalized);
    }
  });

  const observedMax = values.length ? Math.max(...values) : fallback;
  const padded = Math.max(observedMax * 1.2, fallback);
  const clamped = Math.min(Math.max(padded, min), maxCap);
  const nice = niceCeil(clamped);
  return Math.min(Math.max(nice, min), maxCap);
}

function niceCeil(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const multiples = [1, 2, 2.5, 5, 10];
  for (const multiple of multiples) {
    const candidate = multiple * exponent;
    if (candidate >= value) {
      return candidate;
    }
  }
  return 10 * exponent;
}

function clampMsValue(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return value <= 0 ? 0 : value;
}

function configureSparkline(chart, color) {
  if (!chart) {
    return;
  }
  chart.setOption({
    grid: { left: 10, right: 10, top: 10, bottom: 10 },
    xAxis: {
      type: "time",
      show: false,
    },
    yAxis: {
      type: "value",
      show: false,
      min: (value) => value.min,
      max: (value) => value.max,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line" },
      formatter: (params) => {
        if (!params || !params.length) {
          return STRINGS.noData || "Sem dados suficientes no período.";
        }
        const item = params[0];
        const value = Array.isArray(item.value) ? item.value[1] : item.value;
        return `${formatTime(item.value[0])}<br/>${fmtMs(value)}`;
      },
      backgroundColor: "rgba(15, 23, 42, 0.9)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
    },
    series: [
      {
        type: "line",
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: { color: hexToRgba(color, 0.18) },
        data: [],
      },
    ],
  });
}

function resizeCharts() {
  Object.values(charts).forEach((chart) => {
    chart?.resize({ animation: { duration: 200 } });
  });
}

function startEventsRefreshTimer() {
  if (eventsRefreshTimer) {
    return;
  }
  eventsRefreshTimer = window.setInterval(() => {
    if (state.events.length > 0) {
      renderEvents();
    }
  }, 5000);
  window.addEventListener("beforeunload", () => {
    if (eventsRefreshTimer) {
      clearInterval(eventsRefreshTimer);
      eventsRefreshTimer = null;
    }
  });
}

function clearLiveInactivityTimer() {
  if (liveInactivityTimer) {
    clearTimeout(liveInactivityTimer);
    liveInactivityTimer = null;
  }
}

function scheduleLiveInactivityTimer() {
  clearLiveInactivityTimer();
  if (!Number.isFinite(LIVE_INACTIVITY_TIMEOUT_MS) || LIVE_INACTIVITY_TIMEOUT_MS <= 0) {
    return;
  }
  liveInactivityTimer = window.setTimeout(handleLiveInactivity, LIVE_INACTIVITY_TIMEOUT_MS);
}

function handleLiveInactivity() {
  liveInactivityTimer = null;
  if (state.connection !== "connected") {
    return;
  }
  state.connection = "reconnecting";
  updateConnectionStatus();
  closeLiveStream();
  scheduleReconnect();
}

function markLiveDataReceived() {
  if (state.connection !== "connected") {
    state.connection = "connected";
    updateConnectionStatus();
  }
  scheduleLiveInactivityTimer();
}
function openLiveStream() {
  closeLiveStream();
  tryNextEndpoint(0);
}

function tryNextEndpoint(startIndex) {
  const endpoints = LIVE_ENDPOINTS;
  let index = startIndex;
  const tryConnect = () => {
    if (index >= endpoints.length) {
      scheduleReconnect();
      return;
    }
    const endpoint = endpoints[index];
    try {
      eventSource = new EventSource(endpoint);
    } catch (error) {
      console.error("Falha ao abrir EventSource:", error);
      index += 1;
      tryConnect();
      return;
    }

    let opened = false;
    eventSource.onopen = () => {
      opened = true;
      state.connection = "connected";
      state.connectedEndpointIndex = index;
      state.reconnectAttempts = 0;
      updateConnectionStatus();
      scheduleLiveInactivityTimer();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleLivePayload(payload);
      } catch (error) {
        console.error("Falha ao processar payload de live:", error);
      }
    };

    eventSource.onerror = () => {
      closeLiveStream();
      if (!opened) {
        index += 1;
        tryConnect();
        return;
      }
      state.connection = "reconnecting";
      updateConnectionStatus();
      scheduleReconnect();
    };
  };
  tryConnect();
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  state.reconnectAttempts += 1;
  const attempt = Math.min(state.reconnectAttempts, 3);
  const delay = [3000, 6000, 10000][attempt - 1] ?? 10000;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openLiveStream();
  }, delay);
  state.connection = "reconnecting";
  updateConnectionStatus();
}

function closeLiveStream() {
  clearLiveInactivityTimer();
  if (eventSource) {
    try {
      eventSource.close();
    } catch (error) {
      // ignore
    }
    eventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function handleLivePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  state.lastUpdateTs = Number(payload.ts) || Date.now();

  markLiveDataReceived();

  const pingTargets = payload.ping ? Object.keys(payload.ping) : [];
  if (pingTargets.length) {
    updateTargets(pingTargets);
  }

  if (payload.ping) {
    Object.entries(payload.ping).forEach(([target, metrics]) => {
      updateTargetIndicators(target, metrics);
    });
  }

  if (state.selectedTarget && payload.ping?.[state.selectedTarget]) {
    ingestPingMetrics(state.selectedTarget, payload.ping[state.selectedTarget], state.lastUpdateTs);
    heatmapNeedsRefresh = true;
  }

  updateTargetStatusDisplay();

  ingestDnsMetrics(payload.dns, state.lastUpdateTs);
  ingestHttpMetrics(payload.http, state.lastUpdateTs);

  scheduleRender();
  updateConnectionStatus();
}

function updateTargets(targetList) {
  const sorted = Array.from(new Set(targetList)).sort();
  state.targets = sorted;
  if (!state.selectedTarget || !sorted.includes(state.selectedTarget)) {
    const preferred = sorted.includes(DEFAULT_TARGET) ? DEFAULT_TARGET : sorted[0];
    state.selectedTarget = preferred ?? "";
    state.tracerouteExpanded = false;
    if (state.selectedTarget) {
      bootstrapTargetData(state.selectedTarget).catch(() => {});
      fetchTraceroute(state.selectedTarget).catch(() => {});
    }
  }
  if (refs.targetSelect) {
    refs.targetSelect.innerHTML = "";
    sorted.forEach((target) => {
      const option = document.createElement("option");
      option.value = target;
      option.textContent = target;
      if (target === state.selectedTarget) {
        option.selected = true;
      }
      refs.targetSelect.appendChild(option);
    });
    refs.targetSelect.disabled = sorted.length === 0;
  }
  updateTargetStatusDisplay();
}

function updateTargetIndicators(target, metrics) {
  if (!target) {
    return;
  }
  const ageValue = Number(metrics?.age_ms);
  const ageMs = Number.isFinite(ageValue) && ageValue >= 0 ? ageValue : null;
  const fresh = metrics?.fresh === undefined ? null : Boolean(metrics.fresh);
  const modeRaw = typeof metrics?.mode === "string"
    ? metrics.mode.trim()
    : typeof metrics?.pingMode === "string"
      ? metrics.pingMode.trim()
      : "";
  const pingMode = modeRaw ? modeRaw.toUpperCase() : null;

  state.targetIndicators.set(target, {
    fresh,
    ageMs,
    pingMode,
  });
}

function updateTargetStatusDisplay() {
  const target = state.selectedTarget;
  const meta = target ? state.targetIndicators.get(target) : null;

  if (refs.targetMode) {
    if (meta?.pingMode) {
      refs.targetMode.hidden = false;
      refs.targetMode.textContent = meta.pingMode;
      refs.targetMode.setAttribute("title", "Modo de medição atual");
      refs.targetMode.setAttribute("aria-label", `Modo de medição atual: ${meta.pingMode}`);
      const isTcp = meta.pingMode.toUpperCase() === "TCP";
      refs.targetMode.classList.toggle("badge-mode--tcp", isTcp);
    } else {
      refs.targetMode.hidden = true;
      refs.targetMode.removeAttribute("title");
      refs.targetMode.removeAttribute("aria-label");
      refs.targetMode.classList.remove("badge-mode--tcp");
    }
  }

  updateNetworkStatus();
}

// Chooses which DNS aggregate (cold preferred) should drive the UI.
// Called whenever live metrics push a DNS update (every few seconds).
function selectDnsPrimaryStats(aggregate) {
  if (!aggregate) {
    return null;
  }
  if (aggregate.cold && Number(aggregate.cold.samples) > 0) {
    return aggregate.cold;
  }
  if (aggregate.hot && Number(aggregate.hot.samples) > 0) {
    return aggregate.hot;
  }
  return aggregate;
}

function ingestPingMetrics(target, metrics, ts) {
  updateTargetIndicators(target, metrics);
  const summaryMap = state.windowSummaries.get(target) ?? new Map();
  WINDOW_OPTION_MAP.forEach((key) => {
    const summary = buildSummaryFromMetrics(metrics, key);
    if (summary) {
      summaryMap.set(key, summary);
    }
  });
  state.windowSummaries.set(target, summaryMap);

  const recentEntries = Array.isArray(metrics?.recent)
    ? metrics.recent
        .map((item) => {
          const tsValue = Number(item?.ts);
          if (!Number.isFinite(tsValue)) {
            return null;
          }
          const success = item?.success === true || item?.success === 1 || item?.success === "1";
          const rttValue = normalize(item?.rtt_ms);
          return { ts: tsValue, success, rtt: success ? rttValue : null };
        })
        .filter(Boolean)
    : [];

  if (recentEntries.length > 0) {
    const existing = state.pingSamples.get(target) ?? [];
    const merged = mergeSampleSeries(existing, recentEntries);
    state.pingSamples.set(target, merged);
    state.latestSampleTs.set(target, merged.length ? merged[merged.length - 1].ts : null);
  } else {
    const lastSample = metrics?.lastSample;
    if (lastSample) {
      const sampleTs = Number(lastSample.ts ?? ts);
      if (Number.isFinite(sampleTs)) {
        const success = lastSample.up === 1 || lastSample.up === true || Number(lastSample.up) === 1;
        const rttValue = normalize(lastSample.rtt_ms);
        const sample = { ts: sampleTs, success, rtt: success ? rttValue : null };
        const existing = state.pingSamples.get(target) ?? [];
        const latest = state.latestSampleTs.get(target) ?? -Infinity;
        if (sampleTs > latest) {
          const merged = mergeSampleSeries(existing, [sample]);
          state.pingSamples.set(target, merged);
          state.latestSampleTs.set(target, sampleTs);
        }
      }
    }
  }

  if (target === state.selectedTarget) {
    applyCurrentWindowSummary();
    updateEventsFromSummary(getCurrentWindowSummary());
  }

  updateTargetStatusDisplay();
}

function ingestDnsMetrics(dns, ts) {
  if (!dns || !dns.aggregate) {
    return;
  }
  state.dnsLatest = dns.aggregate;
  const stats = selectDnsPrimaryStats(dns.aggregate);
  const value = normalize(stats?.win1m_avg_ms);
  const entry = { ts, value, avg5m: normalize(stats?.win5m_avg_ms) };
  state.dnsSeries.push(entry);
  pruneSeries(state.dnsSeries, DNS_HISTORY_LIMIT_MS);
  updateDnsKpi();
  updateDnsGauge(value);
  updateEventsForMetric("dns", value, thresholds.dns, "DNS lookup elevado", {
    formatter: fmtMs,
    eventType: "dns",
  });
}

function resolveDnsValueForWindow(windowKey) {
  const aggregate = state.dnsLatest;
  const stats = selectDnsPrimaryStats(aggregate);
  if (!stats) {
    return null;
  }
  switch (windowKey) {
    case "5m":
      return normalize(stats.win5m_avg_ms);
    case "15m":
      return normalize(stats.win15m_avg_ms);
    case "60m":
      return normalize(stats.win60m_avg_ms);
    case "1m":
    default:
      return normalize(stats.win1m_avg_ms);
  }
}

function updateDnsKpi() {
  const windowKey = getWindowKeyFromMinutes(state.rangeMinutes);
  const value = resolveDnsValueForWindow(windowKey);
  updateKpi("dns-lookup", value, {
    threshold: thresholds.dns,
    higherIsBad: true,
    trendKey: "dns-lookup",
  });
}

function ingestHttpMetrics(http, ts) {
  if (!http || !http.aggregate) {
    return;
  }
  const ttfbValue = normalize(http.aggregate.ttfb?.win1m_avg_ms);
  const ttfbEntry = {
    ts,
    value: ttfbValue,
    avg5m: normalize(http.aggregate.ttfb?.win5m_avg_ms),
  };
  state.httpTtfbSeries.push(ttfbEntry);
  pruneSeries(state.httpTtfbSeries, DNS_HISTORY_LIMIT_MS);
  state.httpLatest.ttfb = ttfbValue;
  updateKpi("http-ttfb", ttfbValue, {
    threshold: thresholds.ttfb,
    higherIsBad: true,
    trendKey: "http-ttfb",
    subText: `5m: ${fmtMs(ttfbEntry.avg5m)}`,
  });
  updateEventsForMetric("http-ttfb", ttfbValue, thresholds.ttfb, "TTFB elevado", {
    formatter: fmtMs,
    eventType: "http-ttfb",
  });

  const totalValue = normalize(http.aggregate.total?.win1m_avg_ms);
  const totalEntry = {
    ts,
    value: totalValue,
    avg5m: normalize(http.aggregate.total?.win5m_avg_ms),
  };
  state.httpTotalSeries.push(totalEntry);
  pruneSeries(state.httpTotalSeries, DNS_HISTORY_LIMIT_MS);
  state.httpLatest.total = totalValue;
  updateKpi("http-total", totalValue, {
    threshold: thresholds.ttfb,
    higherIsBad: true,
    trendKey: "http-total",
    subText: `5m: ${fmtMs(totalEntry.avg5m)}`,
  });
  updateHttpGauge(totalValue);
}
function updateKpis(summary) {
  const p95 = summary?.win_p95_ms;
  const p50 = summary?.win_p50_ms;
  const avg = summary?.win_avg_ms;
  const loss = summary?.win_loss_pct;
  const availabilitySummary = normalize(summary?.win_availability_pct);
  const status = summary?.status || null;
  updateKpi("ping-p95", p95, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-p95",
    status,
  });
  updateKpi("ping-p50", p50, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-p50",
    status,
  });
  updateKpi("ping-avg", avg, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-avg",
    status,
  });
  updateKpi("ping-loss", loss, {
    threshold: thresholds.loss,
    higherIsBad: true,
    trendKey: "ping-loss",
    formatter: fmtPct,
    status,
  });
  const availability = availabilitySummary != null ? availabilitySummary : loss == null ? null : clampGaugeValue(100 - loss);
  updateKpi("ping-availability", availability, {
    threshold: thresholds.loss,
    higherIsBad: false,
    trendKey: "ping-availability",
    formatter: (value) => fmtPct(value),
    status,
  });
  updateNetworkStatus(summary);
}

function renderKpiValue(element, valueText) {
  if (!element) {
    return;
  }
  if (!valueText || valueText === "—") {
    element.textContent = "—";
    return;
  }
  const normalized = String(valueText).trim();
  const match = normalized.match(/^([+-]?[0-9.,]+)(?:\s?([a-z%°µ]+))?$/i);
  if (!match) {
    element.textContent = normalized;
    return;
  }
  const [, numberPart, unitPart] = match;
  const numberSpan = `<span class="value-number">${numberPart}</span>`;
  const unitSpan = unitPart ? `<span class="value-unit">${unitPart}</span>` : "";
  element.innerHTML = `${numberSpan}${unitSpan}`;
}

function getCurrentWindowSummary() {
  if (!state.selectedTarget) {
    return null;
  }
  const summaries = state.windowSummaries.get(state.selectedTarget);
  if (!summaries) {
    return null;
  }
  const key = getWindowKeyFromMinutes(state.rangeMinutes);
  return summaries.get(key) ?? null;
}

function applyCurrentWindowSummary() {
  const summary = getCurrentWindowSummary();
  updateKpis(summary);
  refreshGaugeValues();
}

function buildSummaryFromMetrics(metrics, key) {
  if (!metrics || !metrics.windows) {
    return null;
  }
  const entry = metrics.windows[key];
  if (!entry) {
    return {
      win_p95_ms: null,
      win_p50_ms: null,
      win_avg_ms: null,
      win_loss_pct: null,
      win_availability_pct: null,
      win_samples: 0,
      status: "insufficient",
    };
  }
  const samples = Number(entry.count ?? entry.samples) || 0;
  const rawStatus =
    typeof entry.status === "string" && entry.status
      ? entry.status
      : samples > 0
        ? "ok"
        : "insufficient";
  const status = samples >= MIN_WINDOW_SAMPLES && rawStatus !== "insufficient" ? rawStatus : "insufficient";
  return {
    win_p95_ms: normalize(entry.p95_ms),
    win_p50_ms: normalize(entry.p50_ms),
    win_avg_ms: normalize(entry.avg_ms),
    win_loss_pct: normalize(entry.loss_pct),
    win_availability_pct: normalize(entry.disponibilidade_pct ?? entry.availability_pct),
    win_samples: samples,
    status,
  };
}

function updateNetworkStatus(summary) {
  if (!refs.networkStatusBar || !refs.networkStatusText) {
    return;
  }
  let entry = summary;
  if (!entry) {
    entry = getCurrentWindowSummary();
  }
  const hasLatency = Number.isFinite(entry?.win_p95_ms);
  const hasLoss = Number.isFinite(entry?.win_loss_pct);
  if (!hasLatency && !hasLoss) {
    refs.networkStatusBar.className = "network-status network-status--idle";
    refs.networkStatusText.textContent = "Aguardando dados de RTT…";
    return;
  }
  const p95Severity = state.severities.get("ping-p95") || "info";
  const lossSeverity = state.severities.get("ping-loss") || "info";
  const p95Rank = severityRank[p95Severity] ?? 0;
  const lossRank = severityRank[lossSeverity] ?? 0;
  const worstSeverity = lossRank > p95Rank ? lossSeverity : p95Severity;
  const worstRank = severityRank[worstSeverity] ?? 0;
  let label = "Rede estável";
  if (worstRank > severityRank.info) {
    label = lossRank > p95Rank ? "Perda de pacotes elevada" : "Latência alta";
  }
  let statusClass = "network-status--ok";
  if (worstRank >= severityRank.critical) {
    statusClass = "network-status--critical";
  } else if (worstRank >= severityRank.warn) {
    statusClass = "network-status--warn";
  }
  refs.networkStatusBar.className = `network-status ${statusClass}`;
  refs.networkStatusText.textContent = label;
}

function updateKpi(key, value, options = {}) {
  const card = kpiCards.find((item) => item.key === key);
  if (!card) {
    return;
  }
  const formatter = typeof options.formatter === "function" ? options.formatter : fmtMs;
  const status = options.status;
  const isInsufficient = status === "insufficient";
  const valueText = isInsufficient
    ? STRINGS.insufficientSamples || "Amostra insuficiente"
    : formatter(value);
  renderKpiValue(card.valueEl, valueText);
  if (isInsufficient) {
    card.valueEl.setAttribute(
      "title",
      STRINGS.insufficientSamples || "Sem dados suficientes no período."
    );
    card.element.setAttribute("data-loading", "true");
  } else if (valueText === "—") {
    card.valueEl.setAttribute("title", STRINGS.noData || "Sem dados suficientes no período.");
    card.element.setAttribute("data-loading", "true");
  } else {
    card.valueEl.removeAttribute("title");
    card.element.removeAttribute("data-loading");
  }
  const hasValue = !isInsufficient && valueText !== "—";
  if (hasValue) {
    card.element.setAttribute("data-active", "true");
  } else {
    card.element.removeAttribute("data-active");
  }
  const severity = isInsufficient
    ? "info"
    : determineSeverity(value, options.threshold, options.higherIsBad !== false);
  const previous = state.severities.get(key) || "info";
  state.severities.set(key, severity);
  card.element.classList.remove("warn", "critical");
  if (severity === "warn") {
    card.element.classList.add("warn");
  } else if (severity === "critical") {
    card.element.classList.add("critical");
  }

  const trend = computeTrend(options.trendKey, value, options.higherIsBad !== false);
  if (card.trendEl) {
    card.trendEl.textContent = trend.label;
    card.trendEl.style.color = trend.color;
  }
  if (card.arrowEl) {
    card.arrowEl.classList.remove("up", "down", "flat");
    card.arrowEl.classList.add(trend.direction);
    card.arrowEl.style.color = trend.color;
  }

  if (!isInsufficient && severityRank[severity] > severityRank[previous]) {
    let message = "";
    switch (key) {
      case "ping-p95":
        message = `RTT p95 ${severity === "critical" ? "crítico" : "elevado"}: ${formatter(value)}`;
        break;
      case "ping-loss":
        message = `Perda de pacotes ${severity === "critical" ? "crítica" : "alta"}: ${formatter(value)}`;
        break;
      case "ping-availability":
        message = `Disponibilidade em ${severity === "critical" ? "estado crítico" : "atenção"}: ${formatter(value)}`;
        break;
      case "dns-lookup":
        message = `DNS lento (${formatter(value)})`;
        break;
      case "http-ttfb":
        message = `TTFB elevado (${formatter(value)})`;
        break;
      default:
        break;
    }
    if (message) {
      pushEvent({
        key: `kpi-${key}-${severity}`,
        type: `kpi-${key}`,
        severity,
        message,
        icon: "⚠",
      });
    }
  }
}

function computeTrend(key, value, higherIsBad) {
  if (!Number.isFinite(value)) {
    return { label: "—", color: "var(--text-muted)", direction: "flat" };
  }
  const buffer = state.trends.get(key) || [];
  buffer.push(value);
  if (buffer.length > 6) {
    buffer.shift();
  }
  state.trends.set(key, buffer);
  if (buffer.length < 2) {
    return { label: "0%", color: "var(--text-muted)", direction: "flat" };
  }
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const delta = last - first;
  const ratio = first === 0 ? 0 : delta / first;
  const percent = Math.abs(ratio * 100);
  const formatted = `${delta === 0 ? "0" : (ratio * 100).toFixed(1)}%`;
  let direction = "flat";
  let color = "var(--text-muted)";
  if (Math.abs(delta) > 0.01) {
    const upIsBad = higherIsBad;
    if (delta > 0) {
      direction = "up";
      color = upIsBad ? "var(--critical)" : "var(--positive)";
    } else {
      direction = "down";
      color = upIsBad ? "var(--positive)" : "var(--critical)";
    }
  }
  if (percent < 2) {
    direction = "flat";
  }
  return { label: formatted, color, direction };
}

function updateEventsFromSummary(summary) {
  if (!summary) {
    return;
  }
  if (summary.status === "insufficient") {
    state.prevValues.set("ping-p95", summary.win_p95_ms);
    return;
  }
  updateEventsForMetric("ping-p95", summary.win_p95_ms, thresholds.p95, "RTT p95 elevado", {
    formatter: fmtMs,
    eventType: "ping",
  });
  updateEventsForMetric("ping-loss", summary.win_loss_pct, thresholds.loss, "Perda elevada", {
    formatter: fmtPct,
    eventType: "ping-loss",
    higherIsBad: true,
  });
  const previous = state.prevValues.get("ping-p95");
  if (Number.isFinite(summary.win_p95_ms) && Number.isFinite(previous)) {
    if (summary.win_p95_ms > previous * 1.4 && summary.win_p95_ms - previous > 20) {
      pushEvent({
        key: "ping-spike",
        type: "ping",
        severity: "warn",
        message: `Spike de RTT p95 (${fmtMs(summary.win_p95_ms)})`,
        icon: "🚀",
      });
    }
  }
  state.prevValues.set("ping-p95", summary.win_p95_ms);
}

function updateEventsForMetric(key, value, threshold, label, options = {}) {
  const higherIsBad = options.higherIsBad !== false;
  const severity = determineSeverity(value, threshold, higherIsBad);
  const prev = state.severities.get(key) || "info";
  state.severities.set(key, severity);
  if (severityRank[severity] > severityRank[prev]) {
    const formatter = typeof options.formatter === "function" ? options.formatter : fmtMs;
    const eventKey = options.eventKey || `${key}_${severity}`;
    const eventType = options.eventType || key;
    pushEvent({
      key: eventKey,
      type: eventType,
      severity,
      message: `${label}: ${formatter(value)}`,
      icon: options.icon || "⚠",
    });
  }
}

function determineSeverity(value, threshold, higherIsBad = true) {
  if (!threshold || value == null || !Number.isFinite(value)) {
    return "info";
  }
  const warn = Number(threshold.warn);
  const crit = Number(threshold.crit);
  if (!higherIsBad) {
    const warnBoundary = Number.isFinite(warn) ? clampGaugeValue(100 - warn) : null;
    const critBoundary = Number.isFinite(crit) ? clampGaugeValue(100 - crit) : null;
    if (critBoundary != null && value < critBoundary) {
      return "critical";
    }
    if (warnBoundary != null && value < warnBoundary) {
      return "warn";
    }
    return "info";
  }
  if (Number.isFinite(crit) && value >= crit) {
    return "critical";
  }
  if (Number.isFinite(warn) && value >= warn) {
    return "warn";
  }
  return "info";
}

function pushEvent({ key, type, severity = "info", message, icon = "ℹ" }) {
  if (!message) {
    return;
  }
  const now = Date.now();
  const eventKey = typeof key === "string" && key.length ? key : null;
  const eventType = typeof type === "string" && type.length ? type : null;

  if (eventKey) {
    const lastAt = state.eventKeyIndex.get(eventKey);
    if (lastAt && now - lastAt < EVENTS_DEDUP_MS) {
      return;
    }
  }

  if (eventType) {
    const lastTypeAt = state.eventTypeIndex.get(eventType);
    if (lastTypeAt && now - lastTypeAt < EVENTS_COOLDOWN_MS) {
      return;
    }
  }

  const entry = { ts: now, severity, message, icon, key: eventKey, type: eventType };
  state.events.unshift(entry);
  if (eventKey) {
    state.eventKeyIndex.set(eventKey, now);
  }
  if (eventType) {
    state.eventTypeIndex.set(eventType, now);
  }
  if (state.events.length > EVENTS_LIMIT) {
    state.events.length = EVENTS_LIMIT;
  }
  pruneEventIndexes(now);
  renderEvents();
}

function pruneEventIndexes(now) {
  const dedupCutoff = now - EVENTS_DEDUP_MS;
  const cooldownCutoff = now - EVENTS_COOLDOWN_MS;
  for (const [eventKey, ts] of state.eventKeyIndex.entries()) {
    if (!Number.isFinite(ts) || ts < dedupCutoff) {
      state.eventKeyIndex.delete(eventKey);
    }
  }
  for (const [eventType, ts] of state.eventTypeIndex.entries()) {
    if (!Number.isFinite(ts) || ts < cooldownCutoff) {
      state.eventTypeIndex.delete(eventType);
    }
  }
}

function renderEvents() {
  if (!refs.eventList) {
    return;
  }
  refs.eventList.innerHTML = "";
  if (state.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "Nenhum evento recente.";
    refs.eventList.appendChild(empty);
    return;
  }
  state.events.forEach((event) => {
    const item = document.createElement("li");
    const severityClass =
      event.severity === "critical" || event.severity === "warn" ? event.severity : "";
    item.className = `event-item ${severityClass}`.trim();
    const iconSpan = document.createElement("span");
    iconSpan.className = "event-icon";
    iconSpan.textContent = event.icon;
    const messageSpan = document.createElement("span");
    messageSpan.className = "event-message";
    messageSpan.textContent = event.message;
    const timeSpan = document.createElement("span");
    timeSpan.className = "event-time";
    timeSpan.textContent = formatRelative(event.ts);
    item.append(iconSpan, messageSpan, timeSpan);
    refs.eventList.appendChild(item);
  });
}
function pruneSeries(series, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (series.length && series[0].ts < cutoff) {
    series.shift();
  }
}

function mergeSampleSeries(existing, incoming) {
  const map = new Map();
  existing.forEach((item) => {
    if (item && Number.isFinite(Number(item.ts))) {
      map.set(Number(item.ts), item);
    }
  });
  incoming.forEach((item) => {
    if (item && Number.isFinite(Number(item.ts))) {
      map.set(Number(item.ts), item);
    }
  });
  const merged = Array.from(map.values()).sort((a, b) => Number(a.ts) - Number(b.ts));
  pruneSeries(merged, HISTORY_LIMIT_MS);
  return merged;
}

function scheduleRender() {
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  updateConnectionStatus();
  updateLastUpdate();
  renderLatencyChart();
  if (heatmapNeedsRefresh) {
    renderHeatmap();
    heatmapNeedsRefresh = false;
  }
  renderSparkline(charts.httpTtfb, state.httpTtfbSeries);
  renderEvents();
  renderTraceroute();
}

function renderLatencyChart() {
  if (!charts.latency || !state.selectedTarget) {
    setChartEmptyState("latencyChart", true);
    return;
  }
  const samples = state.pingSamples.get(state.selectedTarget) || [];
  const cutoff = Date.now() - state.rangeMinutes * 60 * 1000;
  const filtered = samples.filter((sample) => Number(sample.ts) >= cutoff);
  const rttSeries = [];
  const lossSeries = [];
  const rttValues = [];

  filtered
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .forEach((sample) => {
      const ts = Number(sample.ts);
      if (!Number.isFinite(ts)) {
        return;
      }

      if (sample.success && Number.isFinite(sample.rtt)) {
        const value = Number(sample.rtt);
        rttSeries.push({ value: [ts, value] });
        rttValues.push(value);
      } else {
        rttSeries.push({ value: [ts, null] });
        if (sample.success === false) {
          lossSeries.push({ value: [ts, 0] });
        }
      }
    });

  if (rttSeries.length === 0 && lossSeries.length === 0) {
    setChartEmptyState("latencyChart", true);
    charts.latency.setOption({
      yAxis: { min: 0, max: 1 },
      series: [{ data: [] }, { data: [] }],
    });
    return;
  }

  setChartEmptyState("latencyChart", false);

  const hasRtt = rttValues.length > 0;
  const maxRtt = hasRtt ? Math.max(...rttValues) : null;
  const padding = hasRtt ? Math.max(maxRtt * 0.15, 5) : 5;
  const axisMax = hasRtt ? Math.max(maxRtt + padding, maxRtt * 1.15) : padding;
  const resolvedAxisMax = Number.isFinite(axisMax) ? Math.max(axisMax, 1) : 1;

  charts.latency.setOption({
    yAxis: { min: 0, max: resolvedAxisMax },
    series: [{ data: rttSeries }, { data: lossSeries }],
  });
}

function renderHeatmap() {
  if (!HEATMAP_ENABLED || !charts.heatmap || !state.selectedTarget || state.compactMode) {
    setChartEmptyState("heatmapChart", true);
    return;
  }
  const aggregates = state.pingAggregates.get(state.selectedTarget) || [];
  const data = aggregates
    .filter((item) => Number.isFinite(item.p95))
    .map((item) => {
      const bucketIndex = HEAT_BUCKETS.findIndex((boundary) => item.p95 <= boundary);
      const normalizedIndex = bucketIndex === -1 ? HEAT_BUCKETS.length : bucketIndex;
      return [item.ts, normalizedIndex, item.p95, item.samples];
    });
  setChartEmptyState("heatmapChart", data.length === 0);
  charts.heatmap.setOption({
    series: [{ data }],
  });
}

function renderSparkline(chart, list) {
  if (!chart) {
    return;
  }
  const raw = list.map((item) => [item.ts, Number.isFinite(item.value) ? item.value : null]);
  const numericCount = raw.reduce(
    (count, [, value]) => (Number.isFinite(value) ? count + 1 : count),
    0
  );
  const data =
    SPARKLINE_EWMA_ALPHA != null ? applySparklineSmoothing(raw, SPARKLINE_EWMA_ALPHA) : raw;
  const id = chart.getDom()?.id;
  if (id) {
    setChartEmptyState(id, numericCount === 0);
  }
  chart.setOption({ series: [{ data }] });
}

function applySparklineSmoothing(points, alpha) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    return points;
  }
  let previous = null;
  return points.map(([ts, value]) => {
    if (Number.isFinite(value)) {
      previous = previous == null ? value : alpha * value + (1 - alpha) * previous;
      return [ts, previous];
    }
    return [ts, null];
  });
}

function updateConnectionStatus() {
  if (!refs.connectionDot || !refs.connectionText) {
    return;
  }
  const inactivityLimit =
    Number.isFinite(LIVE_INACTIVITY_TIMEOUT_MS) && LIVE_INACTIVITY_TIMEOUT_MS > 0
      ? LIVE_INACTIVITY_TIMEOUT_MS
      : null;
  const lastLiveTs =
    Number.isFinite(state.lastUpdateTs) && state.lastUpdateTs > 0 ? state.lastUpdateTs : null;
  const hasLiveData = lastLiveTs != null;
  const hasFreshData =
    hasLiveData && (!inactivityLimit || Date.now() - lastLiveTs <= inactivityLimit);
  let dotClass = "";
  let text = "";
  switch (state.connection) {
    case "connected":
      if (!hasLiveData) {
        dotClass = "status-dot--connecting";
        text = "Conectando…";
      } else if (!hasFreshData) {
        dotClass = "status-dot--connecting";
        text = "Reconectando…";
      } else {
        dotClass = "";
        text = "Atualizando ao vivo…";
      }
      break;
    case "reconnecting":
      dotClass = "status-dot--connecting";
      text = "Reconectando…";
      break;
    default:
      dotClass = "status-dot--connecting";
      text = "Conectando…";
      break;
  }
  refs.connectionDot.className = `status-dot ${dotClass}`.trim();
  refs.connectionText.textContent = text;
}

function updateLastUpdate() {
  if (!refs.lastUpdate) {
    return;
  }
  if (!state.lastUpdateTs) {
    refs.lastUpdate.textContent = "Última atualização: —";
    refs.lastUpdate.removeAttribute("datetime");
    return;
  }
  const iso = new Date(state.lastUpdateTs).toISOString();
  refs.lastUpdate.textContent = `Última atualização: ${formatTime(state.lastUpdateTs)}`;
  refs.lastUpdate.setAttribute("datetime", iso);
}

async function fetchPingWindowData(target, rangeKey, options = {}) {
  if (!target) {
    return;
  }
  const rangeParam = typeof rangeKey === "string" && rangeKey ? rangeKey : getRangeParamFromMinutes(state.rangeMinutes);
  try {
    const url = await resolveEndpoint(API_PING_WINDOW, { range: rangeParam, target });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      return;
    }

    const resolvedRangeKey = getWindowKeyFromRange(payload.range ?? rangeParam);
    const samples = Array.isArray(payload.samples)
      ? payload.samples
          .map((row) => ({
            ts: Number(row.ts),
            success: Boolean(row.success),
            rtt: normalize(row.rtt_ms),
          }))
          .filter((row) => Number.isFinite(row.ts))
      : [];
    if (samples.length) {
      const existing = state.pingSamples.get(target) ?? [];
      const merged = options.mergeSamples ? mergeSampleSeries(existing, samples) : mergeSampleSeries([], samples);
      state.pingSamples.set(target, merged);
      state.latestSampleTs.set(target, merged.length ? merged[merged.length - 1].ts : null);
    } else if (!state.pingSamples.has(target)) {
      state.pingSamples.set(target, []);
    }

    const aggregates = Array.isArray(payload.aggregates)
      ? payload.aggregates
          .map((row) => ({
            ts: Number(row.ts_min),
            p95: normalize(row.p95_ms),
            samples: Number(row.sent ?? row.samples) || 0,
          }))
          .filter((row) => Number.isFinite(row.ts))
      : [];
    const shouldUpdateAggregates = rangeParam === "60m" || rangeParam === "1h";
    if (shouldUpdateAggregates) {
      state.pingAggregates.set(target, aggregates);
      heatmapNeedsRefresh = true;
    }

    const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : null;
    if (summary) {
      const summaryMap = state.windowSummaries.get(target) ?? new Map();
      summaryMap.set(resolvedRangeKey, {
        win_p95_ms: normalize(summary.win_p95_ms),
        win_p50_ms: normalize(summary.win_p50_ms),
        win_avg_ms: normalize(summary.win_avg_ms),
        win_loss_pct: normalize(summary.win_loss_pct),
        win_samples: Number(summary.win_samples) || 0,
      });
      state.windowSummaries.set(target, summaryMap);
    }

    if (options.updateVisibleSummary) {
      applyCurrentWindowSummary();
    }

    scheduleRender();
  } catch (error) {
    console.error("Falha ao buscar dados da janela de ping:", error);
  }
}

// Normalizes traceroute hops to the client format (single RTT and IP fields).
// Invoked whenever we ingest traceroute payloads from the API.
function normalizeTracerouteHopClient(raw, index) {
  const hopNumber = Number(raw?.hop ?? raw?.index);
  const hop = Number.isFinite(hopNumber) && hopNumber > 0 ? hopNumber : index + 1;
  const ipCandidates = [raw?.ip, raw?.address]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const ip = ipCandidates.length > 0 ? ipCandidates[0] : "*";

  const latencyCandidates = [];
  if (Array.isArray(raw?.rtt)) {
    for (const value of raw.rtt) {
      latencyCandidates.push(value);
    }
  }
  latencyCandidates.push(raw?.rtt_ms, raw?.rtt1_ms, raw?.rtt2_ms, raw?.rtt3_ms);

  const rtt = latencyCandidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0);

  return { hop, ip: ip || "*", rtt_ms: Number.isFinite(rtt) ? rtt : null };
}

// Produces a normalized traceroute result for the UI from API payloads.
// Called on every manual or automatic traceroute refresh.
function normalizeTracerouteResult(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const executedTs = data.executed_at ? Date.parse(data.executed_at) : Number(data.ts);
  const normalizedHops = Array.isArray(data.hops)
    ? data.hops.map((hop, index) => normalizeTracerouteHopClient(hop, index))
    : [];
  return {
    ...data,
    hops: normalizedHops,
    ts: Number.isFinite(executedTs) ? executedTs : null,
    executed_at:
      typeof data.executed_at === "string" && data.executed_at
        ? data.executed_at
        : Number.isFinite(executedTs)
          ? new Date(executedTs).toISOString()
          : null,
  };
}

async function fetchTraceroute(target) {
  if (!target) {
    state.traceroute = null;
    state.tracerouteExpanded = false;
    renderTraceroute();
    return;
  }
  try {
    const url = await resolveEndpoint(API_TRACEROUTE_LATEST, { target });
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        state.traceroute = null;
        state.tracerouteExpanded = false;
        renderTraceroute();
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.json();
    const normalized = normalizeTracerouteResult(raw);
    if (!normalized) {
      state.traceroute = null;
      state.tracerouteExpanded = false;
      renderTraceroute();
      return;
    }
    const isNewResult =
      !state.traceroute ||
      state.traceroute.id !== normalized.id ||
      state.traceroute.ts !== normalized.ts;
    if (isNewResult) {
      state.tracerouteExpanded = !isTracerouteStale(normalized);
    }
    state.traceroute = normalized;
    renderTraceroute();
  } catch (error) {
    console.error("Falha ao buscar traceroute:", error);
  }
}

function renderTraceroute() {
  if (!refs.tracerouteTimeline || !refs.tracerouteMeta) {
    return;
  }
  refs.tracerouteTimeline.innerHTML = "";
  if (state.compactMode) {
    refs.tracerouteMeta.textContent = "Disponível no modo expandido";
    return;
  }
  const traceroute = state.traceroute;
  if (!traceroute || !Array.isArray(traceroute.hops) || traceroute.hops.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.selectedTarget
      ? "Sem dados recentes. Execute um traceroute."
      : "Selecione um alvo para visualizar.";
    refs.tracerouteTimeline.appendChild(empty);
    refs.tracerouteMeta.textContent = "Sem execuções";
    return;
  }
  const executedTs = Number(traceroute.ts);
  const ageMs = Number.isFinite(executedTs) ? Date.now() - executedTs : NaN;
  const isStale = Number.isFinite(ageMs) && ageMs > TRACEROUTE_MAX_AGE_MIN * 60 * 1000;
  if (!isStale) {
    state.tracerouteExpanded = true;
  }
  const ageLabel = Number.isFinite(ageMs) ? formatAgeHhMm(ageMs) : "--:--";
  let metaText;
  if (isStale) {
    metaText = `resultado antigo (${ageLabel} atrás)`;
  } else if (Number.isFinite(executedTs)) {
    metaText = `Executado há ${formatRelative(executedTs)}`;
  } else if (typeof traceroute.executed_at === "string" && traceroute.executed_at) {
    metaText = `Executado em ${traceroute.executed_at}`;
  } else {
    metaText = "Execução recente";
  }
  refs.tracerouteMeta.textContent = metaText;

  const shouldCollapse = isStale && !state.tracerouteExpanded;
  if (shouldCollapse) {
    const notice = document.createElement("div");
    notice.className = "traceroute-collapsed";
    const message = document.createElement("p");
    message.textContent =
      "Resultado antigo oculto. Você pode executar novamente ou visualizar os hops anteriores.";
    const actions = document.createElement("div");
    actions.className = "traceroute-actions";
    const rerunButton = document.createElement("button");
    rerunButton.type = "button";
    rerunButton.className = "primary-button traceroute-rerun";
    rerunButton.textContent = state.tracerouteLoading ? "Executando…" : "Rodar novamente";
    rerunButton.disabled = state.tracerouteLoading;
    rerunButton.addEventListener("click", () => {
      if (!state.selectedTarget || state.tracerouteLoading) {
        return;
      }
      triggerTraceroute(state.selectedTarget).catch(() => {});
    });
    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "ghost-button";
    expandButton.textContent = "Ver hops antigos";
    expandButton.addEventListener("click", () => {
      state.tracerouteExpanded = true;
      renderTraceroute();
    });
    actions.append(rerunButton, expandButton);
    notice.append(message, actions);
    refs.tracerouteTimeline.appendChild(notice);
    return;
  }

  const allNoResponse = traceroute.hops.every((hop) => {
    const ip = typeof hop?.ip === "string" ? hop.ip.trim() : "";
    const rttValue = Number(hop?.rtt_ms);
    return (!ip || ip === "*") && !Number.isFinite(rttValue);
  });

  if (allNoResponse) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Sem resposta dos hops";
    refs.tracerouteTimeline.appendChild(empty);
    return;
  }

  traceroute.hops.forEach((hop, index) => {
    const item = document.createElement("div");
    const rttValue = Number(hop?.rtt_ms);
    const success = Number.isFinite(rttValue);
    item.className = `traceroute-hop ${success ? "ok" : "fail"}`.trim();
    const indexEl = document.createElement("span");
    indexEl.className = "hop-index";
    indexEl.textContent = String(Number.isFinite(Number(hop?.hop)) ? hop.hop : index + 1);
    const info = document.createElement("div");
    info.className = "hop-info";
    const addr = document.createElement("span");
    const hopIp = typeof hop?.ip === "string" && hop.ip.trim().length ? hop.ip.trim() : "*";
    addr.textContent = hopIp;
    const rtt = document.createElement("span");
    rtt.className = "hop-rtt";
    const rttText = Number.isFinite(rttValue) ? fmtMs(rttValue) : "sem resposta";
    rtt.textContent = rttText;
    info.append(addr, rtt);
    item.append(indexEl, info);
    refs.tracerouteTimeline.appendChild(item);
  });
}
async function triggerTraceroute(target) {
  state.tracerouteLoading = true;
  if (refs.tracerouteTrigger) {
    refs.tracerouteTrigger.disabled = true;
    refs.tracerouteTrigger.textContent = "Executando…";
  }
  renderTraceroute();
  try {
    const response = await fetch("/actions/traceroute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data?.id) {
      await fetchTracerouteById(data.id);
    } else {
      await fetchTraceroute(target);
    }
    state.tracerouteExpanded = true;
    pushEvent({ severity: "info", message: `Traceroute para ${target} executado`, icon: "🛰" });
  } catch (error) {
    console.error("Falha ao executar traceroute:", error);
    pushEvent({ severity: "critical", message: "Erro ao executar traceroute", icon: "⛔" });
  } finally {
    state.tracerouteLoading = false;
    if (refs.tracerouteTrigger) {
      refs.tracerouteTrigger.disabled = false;
      refs.tracerouteTrigger.textContent = "Rodar novamente";
    }
    renderTraceroute();
  }
}

async function fetchTracerouteById(id) {
  for (const endpoint of API_TRACEROUTE_BY_ID(id)) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        continue;
      }
      const raw = await response.json();
      const normalized = normalizeTracerouteResult(raw);
      if (!normalized) {
        continue;
      }
      const isNewResult =
        !state.traceroute ||
        state.traceroute.id !== normalized.id ||
        state.traceroute.ts !== normalized.ts;
      if (isNewResult) {
        state.tracerouteExpanded = !isTracerouteStale(normalized);
      }
      state.traceroute = normalized;
      renderTraceroute();
      return;
    } catch (error) {
      // try next endpoint
    }
  }
  await fetchTraceroute(state.selectedTarget);
}

async function resolveEndpoint(paths, params = {}) {
  const origin = window.location.origin;
  for (const path of paths) {
    const url = new URL(path, origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) {
        return url;
      }
    } catch (error) {
      // ignore and try next
    }
  }
  const fallback = new URL(paths[paths.length - 1], origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") {
      fallback.searchParams.set(key, value);
    }
  });
  return fallback;
}

function formatRelative(ts) {
  const diff = Math.max(0, Date.now() - Number(ts));
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) {
    return "agora";
  }
  if (seconds < 60) {
    return `há ${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `há ${minutes}min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `há ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `há ${days}d`;
}

function formatAgeHhMm(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function isTracerouteStale(result) {
  if (!result) {
    return false;
  }
  const ts =
    result.ts != null && Number.isFinite(Number(result.ts))
      ? Number(result.ts)
      : Date.parse(result.executed_at);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const ageMs = Date.now() - ts;
  return Number.isFinite(ageMs) && ageMs > TRACEROUTE_MAX_AGE_MIN * 60 * 1000;
}

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== "string") {
    return `rgba(56,189,248,${alpha})`;
  }
  const cleaned = hex.replace("#", "");
  const bigint = parseInt(cleaned, 16);
  if (Number.isNaN(bigint)) {
    return `rgba(56,189,248,${alpha})`;
  }
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clampGaugeValue(value) {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}
