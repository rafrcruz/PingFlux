const CONFIG = window.UI_CONFIG ?? {};
const STRINGS = window.UI_STRINGS ?? {};

const LIVE_ENDPOINTS = ["/v1/live/metrics", "/live/metrics"];
const API_PING_WINDOW = ["/v1/api/ping/window", "/api/ping/window"];
const API_TRACEROUTE_LATEST = ["/v1/api/traceroute/latest", "/api/traceroute/latest"];
const API_TRACEROUTE_BY_ID = (id) => [`/v1/api/traceroute/${id}`, `/api/traceroute/${id}`];

const RANGE_OPTIONS = Array.isArray(CONFIG.rangeOptions) && CONFIG.rangeOptions.length
  ? CONFIG.rangeOptions
  : [5, 10, 15, 30];
const MAX_RANGE_MINUTES = RANGE_OPTIONS.reduce((max, value) => (value > max ? value : max), 30);
const HISTORY_LIMIT_MS = MAX_RANGE_MINUTES * 60 * 1000;
const DNS_HISTORY_LIMIT_MS = 60 * 60 * 1000;

const thresholds = CONFIG.thresholds ?? {};

const severityRank = { ok: 0, warn: 1, crit: 2 };
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
  visibleUpdateTs: null,
  targets: [],
  selectedTarget: CONFIG.defaultTarget || "",
  paused: false,
  hasPendingWhilePaused: false,
  showLoss: true,
  rangeMinutes: RANGE_OPTIONS.includes(Number(CONFIG.sparklineMinutes))
    ? Number(CONFIG.sparklineMinutes)
    : RANGE_OPTIONS[RANGE_OPTIONS.length - 1],
  pingSeries: new Map(),
  dnsSeries: [],
  httpTtfbSeries: [],
  httpTotalSeries: [],
  trends: new Map(),
  severities: new Map(),
  prevValues: new Map(),
  events: [],
  traceroute: null,
  tracerouteLoading: false,
};

const refs = {
  themeToggle: document.getElementById("themeToggle"),
  connectionDot: document.getElementById("connectionDot"),
  connectionText: document.getElementById("connectionText"),
  lastUpdate: document.getElementById("lastUpdate"),
  targetSelect: document.getElementById("targetSelect"),
  rangeButtons: document.getElementById("rangeButtons"),
  pauseButton: document.getElementById("pauseStream"),
  lossToggle: document.getElementById("lossToggle"),
  resetZoom: document.getElementById("resetZoom"),
  eventList: document.getElementById("eventList"),
  tracerouteTimeline: document.getElementById("tracerouteTimeline"),
  tracerouteMeta: document.getElementById("tracerouteMeta"),
  tracerouteTrigger: document.getElementById("tracerouteTrigger"),
};

const kpiCards = Array.from(document.querySelectorAll(".kpi-card")).map((card) => {
  const key = card.getAttribute("data-kpi");
  return {
    key,
    element: card,
    valueEl: card.querySelector("[data-value]"),
    subEl: card.querySelector(`[data-sub="${key}"]`),
    trendEl: card.querySelector(".trend-label"),
    arrowEl: card.querySelector(".trend-arrow"),
  };
});

const charts = {
  latency: null,
  heatmap: null,
  availability: null,
  dns: null,
  httpTtfb: null,
  httpTotal: null,
};

let eventSource = null;
let reconnectTimer = null;
let renderScheduled = false;
let heatmapNeedsRefresh = false;

init();

function init() {
  applyTooltips();
  mountTheme();
  mountRangeButtons();
  mountControls();
  initCharts();
  openLiveStream();
  if (state.selectedTarget) {
    fetchPingHistory(state.selectedTarget).catch(() => {});
    fetchTraceroute(state.selectedTarget).catch(() => {});
  }
  updatePauseState();
  scheduleRender();
}

function applyTooltips() {
  document.querySelectorAll("[data-tooltip]").forEach((button) => {
    const key = button.getAttribute("data-tooltip");
    if (key && STRINGS[key]) {
      button.setAttribute("title", STRINGS[key]);
    }
  });
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
      state.rangeMinutes = minutes;
      Array.from(refs.rangeButtons.querySelectorAll("button")).forEach((btn) => {
        btn.setAttribute("aria-pressed", btn === button ? "true" : "false");
      });
      scheduleRender();
    });
    refs.rangeButtons.appendChild(button);
  });
}

function mountControls() {
  refs.targetSelect?.addEventListener("change", () => {
    const value = refs.targetSelect.value;
    if (value && value !== state.selectedTarget) {
      state.selectedTarget = value;
      fetchPingHistory(value).catch(() => {});
      fetchTraceroute(value).catch(() => {});
      scheduleRender();
    }
  });

  refs.pauseButton?.addEventListener("click", () => {
    state.paused = !state.paused;
    updatePauseState();
    if (!state.paused && state.hasPendingWhilePaused) {
      state.visibleUpdateTs = state.lastUpdateTs;
      state.hasPendingWhilePaused = false;
      scheduleRender();
    }
  });

  refs.lossToggle?.addEventListener("change", () => {
    state.showLoss = Boolean(refs.lossToggle?.checked);
    updateLatencySeriesVisibility();
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

function updatePauseState() {
  if (!refs.pauseButton) {
    return;
  }
  refs.pauseButton.textContent = state.paused ? "Retomar stream" : "Pausar stream";
  refs.pauseButton.setAttribute("aria-pressed", state.paused ? "true" : "false");
  if (state.paused) {
    refs.pauseButton.classList.add("paused");
  } else {
    refs.pauseButton.classList.remove("paused");
  }
}
function initCharts() {
  if (typeof echarts === "undefined") {
    console.error("ECharts não carregado");
    return;
  }
  charts.latency = echarts.init(document.getElementById("latencyChart"), null, { renderer: "canvas" });
  charts.heatmap = echarts.init(document.getElementById("heatmapChart"), null, { renderer: "canvas" });
  charts.availability = echarts.init(document.getElementById("availabilityGauge"), null, { renderer: "canvas" });
  charts.dns = echarts.init(document.getElementById("dnsSparkline"), null, { renderer: "canvas" });
  charts.httpTtfb = echarts.init(document.getElementById("httpTtfbSparkline"), null, { renderer: "canvas" });
  charts.httpTotal = echarts.init(document.getElementById("httpTotalSparkline"), null, { renderer: "canvas" });

  configureLatencyChart();
  configureHeatmap();
  configureGauge();
  configureSparkline(charts.dns, "#38bdf8");
  configureSparkline(charts.httpTtfb, "#f97316");
  configureSparkline(charts.httpTotal, "#8b5cf6");

  window.addEventListener("resize", () => {
    resizeCharts();
  });
}

function configureLatencyChart() {
  if (!charts.latency) {
    return;
  }
  charts.latency.setOption({
    backgroundColor: "transparent",
    animationDuration: 300,
    animationDurationUpdate: 260,
    legend: {
      top: 0,
      textStyle: { color: getComputedStyle(document.documentElement).getPropertyValue("--text-muted") || "#94a3b8" },
    },
    grid: { left: 60, right: 60, top: 50, bottom: 70 },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        label: {
          backgroundColor: "rgba(15,23,42,0.9)",
        },
      },
      backgroundColor: "rgba(15, 23, 42, 0.88)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
      formatter: (params) => {
        const lines = [params[0]?.axisValueLabel ?? ""];
        params.forEach((serie) => {
          if (!serie || serie.value == null) {
            return;
          }
          let formatted = serie.value[1];
          if (serie.seriesName.includes("Perda")) {
            formatted = `${formatPercent(serie.value[1])}`;
          } else {
            formatted = `${formatMs(serie.value[1])}`;
          }
          lines.push(`${serie.marker} ${serie.seriesName}: ${formatted}`);
        });
        return lines.join("<br />");
      },
    },
    dataZoom: [
      { type: "inside", throttle: 50 },
      { type: "slider", bottom: 8, textStyle: { color: "#94a3b8" } },
    ],
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLine: { lineStyle: { color: "rgba(148, 163, 184, 0.3)" } },
      axisLabel: { color: "var(--text-muted)" },
      splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.15)" } },
    },
    yAxis: [
      {
        type: "value",
        name: "ms",
        nameTextStyle: { color: "var(--text-muted)" },
        axisLabel: {
          color: "var(--text-muted)",
          formatter: (value) => `${Math.round(value)} ms`,
        },
        splitLine: { lineStyle: { color: "rgba(148, 163, 184, 0.12)" } },
      },
      {
        type: "value",
        name: "Perda %",
        alignTicks: true,
        min: 0,
        max: 100,
        axisLabel: {
          color: "var(--text-muted)",
          formatter: (value) => `${Math.round(value)}%`,
        },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "RTT p50",
        type: "line",
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2.4, color: "#38bdf8" },
        emphasis: { focus: "series" },
        data: [],
      },
      {
        name: "RTT médio",
        type: "line",
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2.2, color: "#34d399" },
        emphasis: { focus: "series" },
        data: [],
      },
      {
        name: "RTT p95",
        type: "line",
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2.4, color: "#fbbf24" },
        emphasis: { focus: "series" },
        data: [],
      },
      {
        name: "Perda (%)",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        lineStyle: { width: 1.8, color: "#f87171" },
        areaStyle: { opacity: 0.16, color: "rgba(248, 113, 113, 0.35)" },
        emphasis: { focus: "series" },
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
          return "Sem dados";
        }
        const [ts, , value, count] = params.value;
        return `${formatTime(ts)}<br/>p95: ${formatMs(value)}<br/>Amostras: ${count ?? "n/d"}`;
      },
      backgroundColor: "rgba(15, 23, 42, 0.88)",
      borderWidth: 0,
      textStyle: { color: "#e2e8f0" },
    },
    grid: { left: 80, right: 20, bottom: 50, top: 30 },
    xAxis: {
      type: "time",
      axisLabel: { color: "var(--text-muted)" },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.25)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      data: HEAT_LABELS,
      axisLabel: { color: "var(--text-muted)" },
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

function configureGauge() {
  if (!charts.availability) {
    return;
  }
  const lossWarn = thresholds.loss?.warn ?? 1;
  const lossCrit = thresholds.loss?.crit ?? 5;
  const warnBoundary = clampGaugeValue(100 - lossWarn);
  const critBoundary = clampGaugeValue(100 - lossCrit);
  charts.availability.setOption({
    series: [
      {
        type: "gauge",
        startAngle: 225,
        endAngle: -45,
        min: 0,
        max: 100,
        splitNumber: 10,
        axisLine: {
          lineStyle: {
            width: 18,
            color: [
              [critBoundary / 100, "#ef4444"],
              [warnBoundary / 100, "#facc15"],
              [1, "#22c55e"],
            ],
          },
        },
        pointer: {
          width: 6,
          itemStyle: { color: "var(--text)" },
        },
        axisTick: { show: false },
        splitLine: { length: 12, distance: 6, lineStyle: { color: "rgba(148,163,184,0.25)" } },
        axisLabel: { color: "var(--text-muted)", distance: 10, fontSize: 12 },
        detail: {
          fontSize: 30,
          color: "var(--text)",
          valueAnimation: true,
          formatter: (value) => `${value.toFixed(1)}%`,
        },
        title: { show: false },
        data: [{ value: 0 }],
      },
    ],
  });
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
          return "Sem dados";
        }
        const item = params[0];
        return `${formatTime(item.value[0])}<br/>${formatMs(item.value[1])}`;
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
  if (!state.paused) {
    state.visibleUpdateTs = state.lastUpdateTs;
  } else {
    state.hasPendingWhilePaused = true;
  }

  const pingTargets = payload.ping ? Object.keys(payload.ping) : [];
  if (pingTargets.length) {
    updateTargets(pingTargets);
  }

  if (state.selectedTarget && payload.ping?.[state.selectedTarget]) {
    ingestPingMetrics(state.selectedTarget, payload.ping[state.selectedTarget], state.lastUpdateTs);
    heatmapNeedsRefresh = true;
  }

  ingestDnsMetrics(payload.dns, state.lastUpdateTs);
  ingestHttpMetrics(payload.http, state.lastUpdateTs);

  if (!state.paused) {
    scheduleRender();
  }
  updateConnectionStatus();
}

function updateTargets(targetList) {
  const sorted = Array.from(new Set(targetList)).sort();
  state.targets = sorted;
  if (!state.selectedTarget || !sorted.includes(state.selectedTarget)) {
    const preferred = sorted.includes(CONFIG.defaultTarget) ? CONFIG.defaultTarget : sorted[0];
    state.selectedTarget = preferred ?? "";
    if (state.selectedTarget) {
      fetchPingHistory(state.selectedTarget).catch(() => {});
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
}

function ingestPingMetrics(target, metrics, ts) {
  const entry = {
    ts,
    p50: normalize(metrics?.win1m?.p50_ms),
    p95: normalize(metrics?.win1m?.p95_ms),
    avg: normalize(metrics?.win1m?.avg_ms),
    loss: normalize(metrics?.win1m?.loss_pct),
    samples: Number(metrics?.win1m?.samples) || 0,
    p50_5m: normalize(metrics?.win5m?.p50_ms),
    p95_5m: normalize(metrics?.win5m?.p95_ms),
    avg_5m: normalize(metrics?.win5m?.avg_ms),
    loss_5m: normalize(metrics?.win5m?.loss_pct),
  };
  if (!state.pingSeries.has(target)) {
    state.pingSeries.set(target, []);
  }
  const series = state.pingSeries.get(target);
  series.push(entry);
  pruneSeries(series, HISTORY_LIMIT_MS);
  updateKpis(metrics, entry);
  updateEventsFromPing(entry);
}

function ingestDnsMetrics(dns, ts) {
  if (!dns || !dns.aggregate) {
    return;
  }
  const value = normalize(dns.aggregate.win1m_avg_ms);
  const entry = { ts, value, avg5m: normalize(dns.aggregate.win5m_avg_ms) };
  state.dnsSeries.push(entry);
  pruneSeries(state.dnsSeries, DNS_HISTORY_LIMIT_MS);
  updateKpi("dns-lookup", value, {
    threshold: thresholds.dns,
    higherIsBad: true,
    trendKey: "dns-lookup",
    subText: `5m: ${formatMs(entry.avg5m)}`,
  });
  updateEventsForMetric("dns", value, thresholds.dns, "DNS lookup elevado");
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
  updateKpi("http-ttfb", ttfbValue, {
    threshold: thresholds.ttfb,
    higherIsBad: true,
    trendKey: "http-ttfb",
    subText: `5m: ${formatMs(ttfbEntry.avg5m)}`,
  });
  updateEventsForMetric("http-ttfb", ttfbValue, thresholds.ttfb, "TTFB elevado");

  const totalValue = normalize(http.aggregate.total?.win1m_avg_ms);
  const totalEntry = {
    ts,
    value: totalValue,
    avg5m: normalize(http.aggregate.total?.win5m_avg_ms),
  };
  state.httpTotalSeries.push(totalEntry);
  pruneSeries(state.httpTotalSeries, DNS_HISTORY_LIMIT_MS);
  updateKpi("http-total", totalValue, {
    threshold: thresholds.ttfb,
    higherIsBad: true,
    trendKey: "http-total",
    subText: `5m: ${formatMs(totalEntry.avg5m)}`,
  });
}
function updateKpis(metrics, latestEntry) {
  const loss = latestEntry.loss;
  updateKpi("ping-p95", latestEntry.p95, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-p95",
    subText: `5m: ${formatMs(latestEntry.p95_5m)}`,
  });
  updateKpi("ping-p50", latestEntry.p50, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-p50",
    subText: `5m: ${formatMs(latestEntry.p50_5m)}`,
  });
  updateKpi("ping-avg", latestEntry.avg, {
    threshold: thresholds.p95,
    higherIsBad: true,
    trendKey: "ping-avg",
    subText: `5m: ${formatMs(latestEntry.avg_5m)}`,
  });
  updateKpi("ping-loss", loss, {
    threshold: thresholds.loss,
    higherIsBad: true,
    trendKey: "ping-loss",
    formatter: formatPercent,
    subText: `5m: ${formatPercent(latestEntry.loss_5m)}`,
  });
  const availability = loss == null ? null : clampGaugeValue(100 - loss);
  const availability5m = latestEntry.loss_5m == null ? null : clampGaugeValue(100 - latestEntry.loss_5m);
  updateKpi("ping-availability", availability, {
    threshold: thresholds.loss,
    higherIsBad: false,
    trendKey: "ping-availability",
    formatter: (value) => (value == null ? "—" : `${value.toFixed(1)}%`),
    subText: `5m: ${availability5m == null ? "—" : `${availability5m.toFixed(1)}%`}`,
  });
  updateGauge(availability);
}

function updateGauge(value) {
  if (!charts.availability || value == null) {
    return;
  }
  charts.availability.setOption({ series: [{ data: [{ value }] }] });
}

function updateLatencySeriesVisibility() {
  if (!charts.latency) {
    return;
  }
  charts.latency.setOption({
    series: [
      {},
      {},
      {},
      {
        show: state.showLoss,
      },
    ],
  });
}

function updateKpi(key, value, options = {}) {
  const card = kpiCards.find((item) => item.key === key);
  if (!card) {
    return;
  }
  const formatter = options.formatter || formatMs;
  card.valueEl.textContent = formatter(value);
  if (card.subEl && options.subText) {
    card.subEl.textContent = options.subText;
  }

  const severity = determineSeverity(value, options.threshold, options.higherIsBad !== false);
  const previous = state.severities.get(key) || "ok";
  state.severities.set(key, severity);
  card.element.classList.remove("warn", "crit");
  if (severity === "warn") {
    card.element.classList.add("warn");
  } else if (severity === "crit") {
    card.element.classList.add("crit");
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

  if (severityRank[severity] > severityRank[previous]) {
    let message = "";
    switch (key) {
      case "ping-p95":
        message = `RTT p95 ${severity === "crit" ? "crítico" : "elevado"}: ${formatter(value)}`;
        break;
      case "ping-loss":
        message = `Perda de pacotes ${severity === "crit" ? "crítica" : "alta"}: ${formatPercent(value)}`;
        break;
      case "ping-availability":
        message = `Disponibilidade em ${severity === "crit" ? "estado crítico" : "atenção"}: ${formatter(value)}`;
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
      pushEvent({ severity, message, icon: "⚠" });
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

function updateEventsFromPing(entry) {
  updateEventsForMetric("ping-p95", entry.p95, thresholds.p95, "RTT p95 elevado");
  updateEventsForMetric("ping-loss", entry.loss, thresholds.loss, "Perda elevada");
  if (Number.isFinite(entry.p95) && Number.isFinite(state.prevValues.get("ping-p95"))) {
    const previous = state.prevValues.get("ping-p95");
    if (entry.p95 > previous * 1.4 && entry.p95 - previous > 20) {
      pushEvent({
        severity: "warn",
        message: `Spike de RTT p95 (${formatMs(entry.p95)})`,
        icon: "🚀",
      });
    }
  }
  state.prevValues.set("ping-p95", entry.p95);
}

function updateEventsForMetric(key, value, threshold, label) {
  const severity = determineSeverity(value, threshold, true);
  const prev = state.severities.get(key) || "ok";
  if (severityRank[severity] > severityRank[prev]) {
    pushEvent({ severity, message: `${label}: ${formatValueByThreshold(value, threshold)}`, icon: "⚠" });
  }
}

function determineSeverity(value, threshold, higherIsBad = true) {
  if (!threshold || value == null || !Number.isFinite(value)) {
    return "ok";
  }
  const warn = Number(threshold.warn);
  const crit = Number(threshold.crit);
  if (!higherIsBad) {
    const warnBoundary = Number.isFinite(warn) ? clampGaugeValue(100 - warn) : null;
    const critBoundary = Number.isFinite(crit) ? clampGaugeValue(100 - crit) : null;
    if (critBoundary != null && value < critBoundary) {
      return "crit";
    }
    if (warnBoundary != null && value < warnBoundary) {
      return "warn";
    }
    return "ok";
  }
  if (Number.isFinite(crit) && value >= crit) {
    return "crit";
  }
  if (Number.isFinite(warn) && value >= warn) {
    return "warn";
  }
  return "ok";
}

function formatValueByThreshold(value, threshold) {
  if (!threshold) {
    return formatMs(value);
  }
  return formatMs(value);
}

function pushEvent({ severity = "ok", message, icon = "ℹ" }) {
  if (!message) {
    return;
  }
  const ts = Date.now();
  state.events.unshift({ ts, severity, message, icon });
  if (state.events.length > 10) {
    state.events.length = 10;
  }
  renderEvents();
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
    item.className = `event-item ${event.severity !== "ok" ? event.severity : ""}`.trim();
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
  renderSparkline(charts.dns, state.dnsSeries);
  renderSparkline(charts.httpTtfb, state.httpTtfbSeries);
  renderSparkline(charts.httpTotal, state.httpTotalSeries);
  renderEvents();
  renderTraceroute();
}

function renderLatencyChart() {
  if (!charts.latency || !state.selectedTarget) {
    return;
  }
  const series = state.pingSeries.get(state.selectedTarget) || [];
  const cutoff = Date.now() - state.rangeMinutes * 60 * 1000;
  const filtered = series.filter((item) => item.ts >= cutoff);
  const p50 = filtered.map((item) => [item.ts, item.p50 ?? null]);
  const avg = filtered.map((item) => [item.ts, item.avg ?? null]);
  const p95 = filtered.map((item) => [item.ts, item.p95 ?? null]);
  const loss = filtered.map((item) => [item.ts, item.loss ?? null]);

  charts.latency.setOption({
    series: [
      { data: p50 },
      { data: avg },
      { data: p95 },
      { data: loss, show: state.showLoss },
    ],
  });
}

function renderHeatmap() {
  if (!charts.heatmap || !state.selectedTarget) {
    return;
  }
  const series = state.pingSeries.get(state.selectedTarget) || [];
  const data = series
    .filter((item) => Number.isFinite(item.p95))
    .map((item) => {
      const bucketIndex = HEAT_BUCKETS.findIndex((boundary) => item.p95 <= boundary);
      const normalizedIndex = bucketIndex === -1 ? HEAT_BUCKETS.length : bucketIndex;
      return [item.ts, normalizedIndex, item.p95, item.samples];
    });
  charts.heatmap.setOption({
    series: [{ data }],
  });
}

function renderSparkline(chart, list) {
  if (!chart) {
    return;
  }
  const data = list.map((item) => [item.ts, item.value ?? null]);
  chart.setOption({ series: [{ data }] });
}

function updateConnectionStatus() {
  if (!refs.connectionDot || !refs.connectionText) {
    return;
  }
  let dotClass = "";
  let text = "";
  switch (state.connection) {
    case "connected":
      dotClass = "";
      text = "Atualizando ao vivo…";
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
  if (!state.visibleUpdateTs) {
    refs.lastUpdate.textContent = "Última atualização: —";
    refs.lastUpdate.removeAttribute("datetime");
    return;
  }
  const iso = new Date(state.visibleUpdateTs).toISOString();
  refs.lastUpdate.textContent = `Última atualização: ${formatTime(state.visibleUpdateTs)}`;
  refs.lastUpdate.setAttribute("datetime", iso);
}

async function fetchPingHistory(target) {
  if (!target) {
    return;
  }
  try {
    const url = await resolveEndpoint(API_PING_WINDOW, { range: "1h", target });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      return;
    }
    const mapped = data.map((row) => ({
      ts: Number(row.ts_min),
      p50: normalize(row.p50_ms),
      p95: normalize(row.p95_ms),
      avg: normalize(row.avg_ms),
      loss: normalize(row.loss_pct),
      samples: Number(row.sent) || 0,
      p50_5m: normalize(row.p50_ms),
      p95_5m: normalize(row.p95_ms),
      avg_5m: normalize(row.avg_ms),
      loss_5m: normalize(row.loss_pct),
    }));
    state.pingSeries.set(target, mapped);
    heatmapNeedsRefresh = true;
    scheduleRender();
  } catch (error) {
    console.error("Falha ao buscar histórico de ping:", error);
  }
}

async function fetchTraceroute(target) {
  if (!target) {
    state.traceroute = null;
    renderTraceroute();
    return;
  }
  try {
    const url = await resolveEndpoint(API_TRACEROUTE_LATEST, { target });
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        state.traceroute = null;
        renderTraceroute();
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    state.traceroute = data;
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
  const traceroute = state.traceroute;
  if (!traceroute || !Array.isArray(traceroute.hops) || traceroute.hops.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.selectedTarget ? "Sem dados recentes. Execute um traceroute." : "Selecione um alvo para visualizar.";
    refs.tracerouteTimeline.appendChild(empty);
    refs.tracerouteMeta.textContent = "Sem execuções";
    return;
  }
  refs.tracerouteMeta.textContent = `Executado há ${formatRelative(traceroute.ts)}`;
  traceroute.hops.forEach((hop, index) => {
    const item = document.createElement("div");
    const success = hop && hop.success !== false;
    item.className = `traceroute-hop ${success ? "ok" : "fail"}`.trim();
    const indexEl = document.createElement("span");
    indexEl.className = "hop-index";
    indexEl.textContent = String(index + 1);
    const info = document.createElement("div");
    info.className = "hop-info";
    const addr = document.createElement("span");
    addr.textContent = hop?.address || "*";
    const rtt = document.createElement("span");
    rtt.className = "hop-rtt";
    const rtts = Array.isArray(hop?.rtt) ? hop.rtt.filter((value) => Number.isFinite(Number(value))) : [];
    const rttText = rtts.length ? rtts.map((value) => `${Number(value).toFixed(1)} ms`).join(" · ") : "sem resposta";
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
    pushEvent({ severity: "ok", message: `Traceroute para ${target} executado`, icon: "🛰" });
  } catch (error) {
    console.error("Falha ao executar traceroute:", error);
    pushEvent({ severity: "crit", message: "Erro ao executar traceroute", icon: "⛔" });
  } finally {
    state.tracerouteLoading = false;
    if (refs.tracerouteTrigger) {
      refs.tracerouteTrigger.disabled = false;
      refs.tracerouteTrigger.textContent = "Rodar novamente";
    }
  }
}

async function fetchTracerouteById(id) {
  for (const endpoint of API_TRACEROUTE_BY_ID(id)) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      state.traceroute = data;
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

function normalize(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatMs(value) {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1000) {
    return `${value.toFixed(0)} ms`;
  }
  if (value >= 100) {
    return `${value.toFixed(1)} ms`;
  }
  if (value >= 10) {
    return `${value.toFixed(1)} ms`;
  }
  return `${value.toFixed(2)} ms`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(value < 10 ? 2 : 1)}%`;
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
