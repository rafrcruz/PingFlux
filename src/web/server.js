import http from "http";
import { runTraceroute } from "../collectors/traceroute.js";
import { createLiveMetricsBroadcaster } from "./live-metrics.js";
import { createLogger } from "../runtime/logger.js";
import { getDbFileInfo } from "../storage/db.js";
import { getCollectorStates } from "../runtime/collectorState.js";
import {
  getWindowAggregates as getPingWindows,
  getSamplesInRange as getPingSamples,
} from "../services/pingService.js";
import { getSamplesInRange as getDnsSamples } from "../services/dnsService.js";
import { getSamplesInRange as getHttpSamples } from "../services/httpService.js";
import { getRunById } from "../data/tracerouteRepo.js";

const log = createLogger("web");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  const body = html ?? "";
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = text ?? "";
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function isLoopback(address) {
  if (!address) {
    return false;
  }
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (address.startsWith("127.")) {
    return true;
  }
  return false;
}

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (error, payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(payload);
      }
    };

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }

      total += chunk.length;
      if (total > maxBytes) {
        finish(new Error("Body too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("error", (error) => {
      finish(error);
    });

    req.on("aborted", () => {
      finish(new Error("Request aborted"));
    });

    req.on("end", () => {
      if (settled) {
        return;
      }

      if (chunks.length === 0) {
        finish(null, {});
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish(null, {});
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        finish(null, parsed && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        finish(new Error("Invalid JSON"));
      }
    });
  });
}

const RANGE_TO_DURATION_MS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

const RANGE_OPTIONS = Object.freeze(Object.keys(RANGE_TO_DURATION_MS));
const UI_DEFAULT_TARGET = String(process.env.UI_DEFAULT_TARGET ?? "").trim();
const SPARKLINE_RANGE_OPTIONS = Object.freeze([5, 10, 15]);
const TARGET_PATTERN = /^[A-Za-z0-9.:_-]+$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;

function parseFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseSparklineMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  return SPARKLINE_RANGE_OPTIONS.includes(parsed) ? parsed : 15;
}

function parseRetryInterval(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function sanitizeTargetParam(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const value = raw.trim();
  if (!value || value.length > 255) {
    return "";
  }
  return TARGET_PATTERN.test(value) ? value : "";
}

function sanitizeHostnameParam(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const value = raw.trim();
  if (!value || value.length > 255) {
    return "";
  }
  return HOSTNAME_PATTERN.test(value) ? value : "";
}

function sanitizeUrlParam(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const value = raw.trim();
  if (!value || value.length > 2048) {
    return "";
  }
  if (/[\s\n]/.test(value)) {
    return "";
  }
  return value;
}

const UI_SPARKLINE_MINUTES = parseSparklineMinutes(process.env.UI_SPARKLINE_MINUTES);
const UI_SSE_RETRY_MS = parseRetryInterval(process.env.UI_SSE_RETRY_MS);
const THRESH_P95_WARN_MS = parseFiniteNumber(process.env.THRESH_P95_WARN_MS);
const THRESH_P95_CRIT_MS = parseFiniteNumber(process.env.THRESH_P95_CRIT_MS);
const THRESH_LOSS_WARN_PCT = parseFiniteNumber(process.env.THRESH_LOSS_WARN_PCT);
const THRESH_LOSS_CRIT_PCT = parseFiniteNumber(process.env.THRESH_LOSS_CRIT_PCT);
const THRESH_TTFB_WARN_MS = parseFiniteNumber(process.env.THRESH_TTFB_WARN_MS);
const THRESH_TTFB_CRIT_MS = parseFiniteNumber(process.env.THRESH_TTFB_CRIT_MS);
const THRESH_DNS_WARN_MS = parseFiniteNumber(process.env.THRESH_DNS_WARN_MS);
const THRESH_DNS_CRIT_MS = parseFiniteNumber(process.env.THRESH_DNS_CRIT_MS);

function buildThresholdPair(warn, crit) {
  return {
    warn: parseFiniteNumber(warn),
    crit: parseFiniteNumber(crit),
  };
}

function getUiConfig(providedConfig) {
  const base = providedConfig && typeof providedConfig === "object" ? providedConfig : {};
  const thresholds = base.thresholds && typeof base.thresholds === "object" ? base.thresholds : {};

  return {
    defaultTarget: typeof base.defaultTarget === "string" ? base.defaultTarget : UI_DEFAULT_TARGET,
    sparklineMinutes: parseSparklineMinutes(base.sparklineMinutes ?? UI_SPARKLINE_MINUTES),
    sseRetryMs: parseRetryInterval(base.sseRetryMs ?? UI_SSE_RETRY_MS),
    rangeOptions: Array.from(SPARKLINE_RANGE_OPTIONS),
    thresholds: {
      p95: buildThresholdPair(
        thresholds.p95?.warn ?? THRESH_P95_WARN_MS,
        thresholds.p95?.crit ?? THRESH_P95_CRIT_MS
      ),
      loss: buildThresholdPair(
        thresholds.loss?.warn ?? THRESH_LOSS_WARN_PCT,
        thresholds.loss?.crit ?? THRESH_LOSS_CRIT_PCT
      ),
      dns: buildThresholdPair(
        thresholds.dns?.warn ?? THRESH_DNS_WARN_MS,
        thresholds.dns?.crit ?? THRESH_DNS_CRIT_MS
      ),
      ttfb: buildThresholdPair(
        thresholds.ttfb?.warn ?? THRESH_TTFB_WARN_MS,
        thresholds.ttfb?.crit ?? THRESH_TTFB_CRIT_MS
      ),
    },
  };
}

function renderIndexHtml(providedConfig) {
  const uiConfig = getUiConfig(providedConfig);
  const tooltipTexts = {
    pingP95: "p95: 95% das amostras tiveram RTT menor ou igual a este valor; bom para ver picos.",
    pingAvg: "RTT médio: tempo médio de resposta no último minuto.",
    pingLoss: "Perda: % de pacotes que não retornaram no período.",
    pingAvailability: "Disponibilidade: estimativa de 100 - perda; quanto maior, melhor.",
    dnsLookup: "DNS lookup (1m): tempo médio de resolução DNS no último minuto.",
    httpTtfb: "TTFB (1m): tempo médio até o primeiro byte nas verificações HTTP.",
  };

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PingFlux · Live</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.45;
        background-color: #0b1120;
      }

      body {
        margin: 0;
        padding: 0;
        background: radial-gradient(circle at top, rgba(56, 189, 248, 0.08), transparent 55%), #0b1120;
        color: #e2e8f0;
      }

      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 64px;
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-end;
      }

      h1 {
        margin: 0;
        font-size: clamp(2rem, 3vw, 2.6rem);
        font-weight: 600;
        letter-spacing: -0.02em;
      }

      .subtitle {
        margin: 4px 0 0;
        color: rgba(148, 163, 184, 0.9);
        font-size: 0.95rem;
      }

      .status-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
        min-width: 200px;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 500;
        border: 1px solid rgba(34, 197, 94, 0.4);
        background: rgba(34, 197, 94, 0.12);
        color: #34d399;
        transition: all 0.2s ease;
      }

      .status.connecting {
        border-color: rgba(59, 130, 246, 0.4);
        background: rgba(59, 130, 246, 0.12);
        color: #60a5fa;
      }

      .status.reconnecting {
        border-color: rgba(250, 204, 21, 0.5);
        background: rgba(250, 204, 21, 0.12);
        color: #facc15;
      }

      .last-update {
        font-size: 0.85rem;
        color: #94a3b8;
      }

      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: flex-end;
      }

      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 0.85rem;
        color: #94a3b8;
      }

      select {
        appearance: none;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(15, 23, 42, 0.9);
        color: inherit;
        font-size: 0.95rem;
        min-width: 170px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }

      select:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 16px;
      }

      .kpi-card {
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 14px;
        padding: 16px;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.35);
        transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
      }

      .kpi-card.warn {
        border-color: rgba(250, 204, 21, 0.9);
        background: rgba(250, 204, 21, 0.08);
      }

      .kpi-card.crit {
        border-color: rgba(239, 68, 68, 0.95);
        background: rgba(239, 68, 68, 0.1);
      }

      .kpi-label {
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(148, 163, 184, 0.85);
      }

      .kpi-value {
        margin-top: 10px;
        font-size: clamp(1.7rem, 3vw, 2.3rem);
        font-weight: 600;
        color: #f8fafc;
      }

      .section-card {
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.35);
      }

      .section-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }

      .section-header h2 {
        margin: 0;
        font-size: 1.2rem;
        font-weight: 600;
      }

      .sparkline-chart {
        position: relative;
        width: 100%;
        height: 160px;
      }

      #sparkline {
        width: 100%;
        height: 100%;
        display: block;
      }

      #sparkline-empty {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #94a3b8;
        font-size: 0.95rem;
      }

      .sparkline-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        font-size: 0.78rem;
        color: #94a3b8;
        margin-top: 12px;
      }

      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        display: inline-block;
      }

      .legend-dot.avg {
        background: #38bdf8;
      }

      .legend-dot.p95 {
        background: #34d399;
      }

      @media (max-width: 640px) {
        .status-panel {
          align-items: flex-start;
        }

        .kpi-grid {
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        }

        .kpi-value {
          font-size: 1.8rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>PingFlux</h1>
          <p class="subtitle">Dashboard de latência em tempo real.</p>
        </div>
        <div class="status-panel">
          <span id="connection-status" class="status connecting">Conectando…</span>
          <span class="last-update">Última atualização: <strong id="last-update">—</strong></span>
        </div>
      </header>

      <section class="controls" aria-label="Controles do dashboard">
        <label>
          Target
          <select id="target-select" name="target" disabled>
            <option value="" disabled selected>Carregando…</option>
          </select>
        </label>
        <label>
          Range visual
          <select id="range-select" name="range"></select>
        </label>
      </section>

      <section class="kpi-grid" aria-live="polite">
        <div class="kpi-card" data-kpi="ping-p95" title="${tooltipTexts.pingP95}">
          <span class="kpi-label">RTT p95 (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-avg" title="${tooltipTexts.pingAvg}">
          <span class="kpi-label">RTT médio (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-loss" title="${tooltipTexts.pingLoss}">
          <span class="kpi-label">Perda (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-availability" title="${tooltipTexts.pingAvailability}">
          <span class="kpi-label">Disponibilidade (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="dns-lookup" title="${tooltipTexts.dnsLookup}">
          <span class="kpi-label">DNS lookup (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="http-ttfb" title="${tooltipTexts.httpTtfb}">
          <span class="kpi-label">TTFB (1m)</span>
          <span class="kpi-value">—</span>
        </div>
      </section>

      <section class="section-card" aria-label="Tendência das métricas">
        <div class="section-header">
          <h2>Tendência (média × p95)</h2>
          <span class="last-update" id="sparkline-range-label">Últimos ${uiConfig.sparklineMinutes} minutos</span>
        </div>
        <div class="sparkline-chart">
          <svg id="sparkline" viewBox="0 0 600 160" role="img" aria-label="Série histórica do alvo selecionado"></svg>
          <div id="sparkline-empty">Sem dados suficientes.</div>
        </div>
        <div class="sparkline-legend">
          <span class="legend-item"><span class="legend-dot avg"></span>Média (1m)</span>
          <span class="legend-item"><span class="legend-dot p95"></span>P95 (1m)</span>
        </div>
      </section>
    </main>

    <script type="module">
      const UI_CONFIG = ${JSON.stringify(uiConfig)};
      const TOOLTIP_EMPTY = "Sem dados no período.";

      const rangeOptions = Array.isArray(UI_CONFIG.rangeOptions) && UI_CONFIG.rangeOptions.length
        ? [...new Set(UI_CONFIG.rangeOptions.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value)))]
            .sort((a, b) => a - b)
        : [5, 10, 15];
      const maxHistoryMinutes = rangeOptions[rangeOptions.length - 1] ?? 15;
      const historyWindowMs = maxHistoryMinutes * 60 * 1000;

      const state = {
        target: "",
        rangeMinutes: rangeOptions.includes(Number(UI_CONFIG.sparklineMinutes))
          ? Number(UI_CONFIG.sparklineMinutes)
          : rangeOptions[rangeOptions.length - 1],
      };

      const targetSelect = document.getElementById("target-select");
      const rangeSelect = document.getElementById("range-select");
      const statusBadge = document.getElementById("connection-status");
      const lastUpdateEl = document.getElementById("last-update");
      const sparklineSvg = document.getElementById("sparkline");
      const sparklineEmpty = document.getElementById("sparkline-empty");
      const sparklineRangeLabel = document.getElementById("sparkline-range-label");

      const kpiDefs = {
        pingP95: {
          card: document.querySelector('[data-kpi="ping-p95"]'),
          value: document.querySelector('[data-kpi="ping-p95"] .kpi-value'),
          tooltip: "${tooltipTexts.pingP95}",
          thresholdKey: "p95",
          format: formatMs,
        },
        pingAvg: {
          card: document.querySelector('[data-kpi="ping-avg"]'),
          value: document.querySelector('[data-kpi="ping-avg"] .kpi-value'),
          tooltip: "${tooltipTexts.pingAvg}",
          thresholdKey: null,
          format: formatMs,
        },
        pingLoss: {
          card: document.querySelector('[data-kpi="ping-loss"]'),
          value: document.querySelector('[data-kpi="ping-loss"] .kpi-value'),
          tooltip: "${tooltipTexts.pingLoss}",
          thresholdKey: "loss",
          format: formatPct,
        },
        pingAvailability: {
          card: document.querySelector('[data-kpi="ping-availability"]'),
          value: document.querySelector('[data-kpi="ping-availability"] .kpi-value'),
          tooltip: "${tooltipTexts.pingAvailability}",
          thresholdKey: "loss",
          format: formatPct,
        },
        dnsLookup: {
          card: document.querySelector('[data-kpi="dns-lookup"]'),
          value: document.querySelector('[data-kpi="dns-lookup"] .kpi-value'),
          tooltip: "${tooltipTexts.dnsLookup}",
          thresholdKey: "dns",
          format: formatMs,
        },
        httpTtfb: {
          card: document.querySelector('[data-kpi="http-ttfb"]'),
          value: document.querySelector('[data-kpi="http-ttfb"] .kpi-value'),
          tooltip: "${tooltipTexts.httpTtfb}",
          thresholdKey: "ttfb",
          format: formatMs,
        },
      };

      const thresholds = UI_CONFIG.thresholds ?? {};
      const history = new Map();
      let latestPayload = null;
      let eventSource = null;
      let reconnectTimer = null;

      function formatMs(value) {
        if (!Number.isFinite(value)) {
          return "—";
        }
        if (Math.abs(value) >= 100) {
          return Math.round(value) + " ms";
        }
        if (Math.abs(value) >= 10) {
          return value.toFixed(1) + " ms";
        }
        return value.toFixed(2) + " ms";
      }

      function formatPct(value) {
        if (!Number.isFinite(value)) {
          return "—";
        }
        if (Math.abs(value) >= 10) {
          return value.toFixed(1) + " %";
        }
        return value.toFixed(2) + " %";
      }

      function normalizeNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }

      function updateRangeSelect() {
        rangeSelect.innerHTML = "";
        for (const minutes of rangeOptions) {
          const option = document.createElement("option");
          option.value = String(minutes);
          option.textContent = String(minutes) + " min";
          if (minutes === state.rangeMinutes) {
            option.selected = true;
          }
          rangeSelect.appendChild(option);
        }
        sparklineRangeLabel.textContent = "Últimos " + state.rangeMinutes + " minutos";
      }

      function applyThreshold(card, compareValue, thresholdKey) {
        card.classList.remove("warn", "crit");
        if (!thresholdKey) {
          return;
        }
        const config = thresholds[thresholdKey];
        if (!config) {
          return;
        }
        if (!Number.isFinite(compareValue)) {
          return;
        }
        const { warn, crit } = config;
        if (Number.isFinite(crit) && compareValue >= crit) {
          card.classList.add("crit");
        } else if (Number.isFinite(warn) && compareValue >= warn) {
          card.classList.add("warn");
        }
      }

      function updateMetric(key, value, compareValue = value) {
        const def = kpiDefs[key];
        if (!def) {
          return;
        }
        const hasValue = Number.isFinite(value);
        def.value.textContent = hasValue ? def.format(value) : "—";
        def.card.setAttribute("title", hasValue ? def.tooltip : TOOLTIP_EMPTY);
        applyThreshold(def.card, Number.isFinite(compareValue) ? compareValue : NaN, def.thresholdKey);
      }

      function updatePingMetrics(metrics) {
        const win1m = metrics?.win1m ?? {};
        const p95 = normalizeNumber(win1m.p95_ms);
        const avg = normalizeNumber(win1m.avg_ms);
        const loss = normalizeNumber(win1m.loss_pct);
        const availability = loss === null ? null : Math.max(0, Math.min(100, 100 - loss));

        updateMetric("pingP95", p95);
        updateMetric("pingAvg", avg);
        updateMetric("pingLoss", loss);
        updateMetric("pingAvailability", availability, loss ?? NaN);
      }

      function updateAggregates(payload) {
        const dnsAvg = normalizeNumber(payload?.dns?.aggregate?.win1m_avg_ms);
        updateMetric("dnsLookup", dnsAvg);

        const ttfbAvg = normalizeNumber(payload?.http?.aggregate?.ttfb?.win1m_avg_ms);
        updateMetric("httpTtfb", ttfbAvg);
      }

      function pruneHistory(buffer, cutoff) {
        while (buffer.length && buffer[0].ts < cutoff) {
          buffer.shift();
        }
      }

      function updateHistory(payload) {
        const timestamp = Number(payload?.ts);
        const baseTs = Number.isFinite(timestamp) ? timestamp : Date.now();
        const cutoff = baseTs - historyWindowMs;

        const ping = payload?.ping ?? {};
        for (const [target, targetMetrics] of Object.entries(ping)) {
          const win1m = targetMetrics?.win1m ?? {};
          const entry = {
            ts: baseTs,
            avg: normalizeNumber(win1m.avg_ms),
            p95: normalizeNumber(win1m.p95_ms),
          };
          let buffer = history.get(target);
          if (!buffer) {
            buffer = [];
            history.set(target, buffer);
          }
          buffer.push(entry);
          pruneHistory(buffer, cutoff);
        }

        for (const [target, buffer] of history.entries()) {
          if (!ping[target]) {
            pruneHistory(buffer, cutoff);
          }
        }
      }

      function renderSparkline(target) {
        sparklineSvg.innerHTML = "";
        if (!target) {
          sparklineEmpty.style.display = "flex";
          sparklineSvg.setAttribute("aria-hidden", "true");
          return;
        }

        const now = Date.now();
        const cutoff = now - state.rangeMinutes * 60 * 1000;
        const buffer = history.get(target) || [];
        const points = buffer.filter((entry) => entry.ts >= cutoff);

        const values = [];
        for (const entry of points) {
          if (Number.isFinite(entry.avg)) {
            values.push(entry.avg);
          }
          if (Number.isFinite(entry.p95)) {
            values.push(entry.p95);
          }
        }

        if (!points.length || !values.length) {
          sparklineEmpty.style.display = "flex";
          sparklineSvg.setAttribute("aria-hidden", "true");
          return;
        }

        sparklineEmpty.style.display = "none";
        sparklineSvg.setAttribute("aria-hidden", "false");
        sparklineSvg.setAttribute("aria-label", "Série histórica do alvo " + target);

        const width = 600;
        const height = 160;
        const padding = { top: 12, right: 12, bottom: 16, left: 12 };
        sparklineSvg.setAttribute("viewBox", "0 0 " + width + " " + height);

        const minTs = Math.min(cutoff, ...points.map((entry) => entry.ts));
        const maxTs = Math.max(...points.map((entry) => entry.ts), minTs + 1);
        const rangeTs = Math.max(maxTs - minTs, 1);

        const minValue = values.reduce((acc, value) => (value < acc ? value : acc), values[0]);
        const maxValue = values.reduce((acc, value) => (value > acc ? value : acc), values[0]);
        const expand = (maxValue - minValue) * 0.1;
        const valueMin = minValue - expand;
        const valueMax = maxValue + expand;
        const valueRange = Math.max(valueMax - valueMin, 1);

        const projectX = (ts) => {
          return (
            padding.left +
            ((ts - minTs) / rangeTs) * (width - padding.left - padding.right)
          );
        };

        const projectY = (value) => {
          const clamped = Math.max(Math.min(value, valueMax), valueMin);
          return (
            height -
            padding.bottom -
            ((clamped - valueMin) / valueRange) * (height - padding.top - padding.bottom)
          );
        };

        function buildPath(pointsList, key, color) {
          const valid = pointsList.filter((entry) => Number.isFinite(entry[key]));
          if (!valid.length) {
            return null;
          }
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          const d = valid
            .map((entry, index) => {
              const command = index === 0 ? "M" : "L";
              const x = projectX(entry.ts).toFixed(2);
              const y = projectY(entry[key]).toFixed(2);
              return command + x + "," + y;
            })
            .join(" ");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", "2.4");
          path.setAttribute("stroke-linejoin", "round");
          path.setAttribute("stroke-linecap", "round");
          return path;
        }

        const avgPath = buildPath(points, "avg", "#38bdf8");
        const p95Path = buildPath(points, "p95", "#34d399");

        if (avgPath) {
          sparklineSvg.appendChild(avgPath);
        }
        if (p95Path) {
          sparklineSvg.appendChild(p95Path);
        }
      }

      function setConnectionStatus(mode) {
        statusBadge.classList.remove("connecting", "reconnecting");
        if (mode === "live") {
          statusBadge.textContent = "Atualizando ao vivo…";
        } else if (mode === "reconnecting") {
          statusBadge.classList.add("reconnecting");
          statusBadge.textContent = "Reconectando…";
        } else {
          statusBadge.classList.add("connecting");
          statusBadge.textContent = "Conectando…";
        }
      }

      function updateLastUpdate(ts) {
        const timestamp = Number(ts);
        if (!Number.isFinite(timestamp)) {
          lastUpdateEl.textContent = "—";
          return;
        }
        const formatter = new Intl.DateTimeFormat("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        lastUpdateEl.textContent = formatter.format(new Date(timestamp));
      }

      function updateTargetOptions(payloadTargets) {
        const options = Array.from(new Set(payloadTargets || [])).filter(Boolean).sort();
        const previous = state.target;

        if (options.length === 0) {
          state.target = "";
          targetSelect.innerHTML = '<option value="" disabled selected>Sem alvos</option>';
          targetSelect.disabled = true;
          return;
        }

        targetSelect.disabled = false;
        targetSelect.innerHTML = "";
        for (const target of options) {
          const option = document.createElement("option");
          option.value = target;
          option.textContent = target;
          targetSelect.appendChild(option);
        }

        if (!previous) {
          if (UI_CONFIG.defaultTarget && options.includes(UI_CONFIG.defaultTarget)) {
            state.target = UI_CONFIG.defaultTarget;
          } else {
            state.target = options[0];
          }
        } else if (!options.includes(previous)) {
          if (UI_CONFIG.defaultTarget && options.includes(UI_CONFIG.defaultTarget)) {
            state.target = UI_CONFIG.defaultTarget;
          } else {
            state.target = options[0];
          }
        }

        targetSelect.value = state.target;
      }

      function handlePayload(payload) {
        latestPayload = payload;
        const targets = Object.keys(payload?.ping ?? {});
        updateTargetOptions(targets);
        updateHistory(payload);
        updatePingMetrics(state.target ? payload?.ping?.[state.target] : null);
        updateAggregates(payload);
        renderSparkline(state.target);
        updateLastUpdate(payload?.ts);
      }

      function connect(isReconnect = false) {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        setConnectionStatus(isReconnect ? "reconnecting" : "connecting");
        eventSource = new EventSource("/v1/live/metrics");

        eventSource.onopen = () => {
          setConnectionStatus("live");
        };

        eventSource.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            handlePayload(payload);
          } catch (error) {
            console.error("Falha ao processar payload de métricas:", error);
          }
        };

        eventSource.onerror = () => {
          setConnectionStatus("reconnecting");
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect(true);
            }, Number(UI_CONFIG.sseRetryMs) || 3000);
          }
        };
      }

      rangeSelect.addEventListener("change", (event) => {
        const minutes = Number.parseInt(event.target.value, 10);
        state.rangeMinutes = rangeOptions.includes(minutes) ? minutes : state.rangeMinutes;
        updateRangeSelect();
        renderSparkline(state.target);
      });

      targetSelect.addEventListener("change", (event) => {
        const value = String(event.target.value || "").trim();
        if (!value) {
          return;
        }
        state.target = value;
        if (latestPayload) {
          updatePingMetrics(latestPayload?.ping?.[state.target] ?? null);
          renderSparkline(state.target);
        }
      });

      updateRangeSelect();
      connect();

      window.addEventListener("beforeunload", () => {
        if (eventSource) {
          eventSource.close();
        }
      });
    </script>
  </body>
</html>`;
}
function resolveRangeWindow(rawRange) {
  const normalized = typeof rawRange === "string" ? rawRange.trim().toLowerCase() : "";
  const rangeKey = RANGE_TO_DURATION_MS[normalized] ? normalized : "1h";
  const durationMs = RANGE_TO_DURATION_MS[rangeKey];
  const nowMs = Date.now();
  const fromMs = nowMs - durationMs;

  return { fromMs, toMs: nowMs };
}

function createRequestHandler(db, appConfig, options = {}) {
  const liveMetrics = createLiveMetricsBroadcaster({
    config: {
      pushIntervalMs: options?.live?.pushIntervalMs,
      useWindows: options?.live?.useWindows,
      pingTargets: options?.live?.pingTargets,
    },
  });

  const handler = async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: "Loopback access only" });
      return;
    }

    const { method, url } = req;
    if (!method || !url) {
      sendText(res, 400, "Bad request");
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url, "http://127.0.0.1");
    } catch (error) {
      sendText(res, 400, "Invalid URL");
      return;
    }

    const pathname = parsedUrl.pathname;

    if (method === "GET" && pathname === "/health") {
      const dbInfo = getDbFileInfo();
      let dbOk = false;
      try {
        db?.prepare("SELECT 1").get();
        dbOk = true;
      } catch (error) {
        dbOk = false;
        log.warn("Health check query failed", error);
      }

      const sizeMb = dbInfo.exists ? Number((dbInfo.sizeBytes / (1024 * 1024)).toFixed(3)) : 0;
      const collectorStates = getCollectorStates();
      const liveStatus = liveMetrics
        ? liveMetrics.getStatus()
        : { interval_ms: null, subscribers: 0, last_dispatch_ts: null };

      sendJson(res, 200, {
        db: {
          ok: dbOk,
          size_mb: sizeMb,
          last_vacuum_at: null,
        },
        collectors: {
          ping: collectorStates.ping?.status ?? "down",
          dns: collectorStates.dns?.status ?? "down",
          http: collectorStates.http?.status ?? "down",
        },
        live: liveStatus,
      });
      return;
    }

    if (method === "GET" && pathname === "/ready") {
      try {
        db?.prepare("SELECT 1").get();
        sendJson(res, 200, { ready: true });
      } catch (error) {
        sendJson(res, 503, { ready: false, error: error?.message ?? "Database unavailable" });
      }
      return;
    }

    if (method === "GET" && pathname === "/v1/api/ui-config") {
      sendJson(res, 200, getUiConfig(appConfig));
      return;
    }

    if (method === "GET" && pathname === "/v1/live/metrics") {
      if (!liveMetrics) {
        sendJson(res, 503, { error: "Live metrics unavailable" });
        return;
      }
      liveMetrics.handleRequest(req, res);
      return;
    }

    if (method === "POST" && pathname === "/v1/actions/traceroute") {
      let body;
      try {
        body = await readJsonBody(req, 16 * 1024);
      } catch (error) {
        const status = error?.message === "Body too large" ? 413 : 400;
        sendJson(res, status, { error: error?.message ?? "Invalid body" });
        return;
      }

      const payload = body && typeof body === "object" ? body : {};
      const target = sanitizeTargetParam(payload.target ?? "");
      const maxHops = Number.parseInt(payload.maxHops, 10);
      const timeoutMs = Number.parseInt(payload.timeoutMs, 10);

      if (!target) {
        sendJson(res, 400, { error: "Invalid target" });
        return;
      }

      const options = {};
      if (Number.isFinite(maxHops)) {
        options.maxHops = Math.min(Math.max(maxHops, 1), 60);
      }
      if (Number.isFinite(timeoutMs)) {
        options.timeoutMs = Math.min(Math.max(timeoutMs, 1000), 60000);
      }

      try {
        const result = await runTraceroute(target, options);
        sendJson(res, 200, {
          id: result.id,
          ts: result.ts,
          target: result.target,
          success: result.success,
        });
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Traceroute failed" });
      }
      return;
    }

    if (method === "GET" && pathname === "/v1/api/ping/window") {
      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawTarget = parsedUrl.searchParams.get("target");
      const target = sanitizeTargetParam(rawTarget);
      if (rawTarget && !target) {
        sendJson(res, 400, { error: "Invalid target" });
        return;
      }

      try {
        if (target) {
          const rows = getPingWindows({ fromMs, toMs, target });
          sendJson(res, 200, rows);
        } else {
          const rows = getPingWindows({ fromMs, toMs });
          const grouped = Object.create(null);
          for (const row of rows) {
            if (!grouped[row.target]) {
              grouped[row.target] = [];
            }
            grouped[row.target].push(row);
          }
          sendJson(res, 200, grouped);
        }
      } catch (error) {
        log.error("Failed to query ping windows", error);
        sendJson(res, 500, { error: "Query failed" });
      }
      return;
    }

    if (method === "GET" && pathname === "/v1/api/dns") {
      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawHostname = parsedUrl.searchParams.get("hostname");
      const hostname = sanitizeHostnameParam(rawHostname);
      if (rawHostname && !hostname) {
        sendJson(res, 400, { error: "Invalid hostname" });
        return;
      }

      try {
        const rows = hostname
          ? getDnsSamples({ fromMs, toMs, hostname })
          : getDnsSamples({ fromMs, toMs });
        const mapped = rows.map((row) => ({
          ts: row.ts,
          hostname: row.hostname,
          resolver: row.resolver,
          lookup_ms: row.lookup_ms,
          success: row.success === 1 || row.success === true,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        log.error("Failed to query DNS samples", error);
        sendJson(res, 500, { error: "Query failed" });
      }
      return;
    }

    if (method === "GET" && pathname === "/v1/api/http") {
      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawUrlParam = parsedUrl.searchParams.get("url");
      const urlParam = sanitizeUrlParam(rawUrlParam);
      if (rawUrlParam && !urlParam) {
        sendJson(res, 400, { error: "Invalid url parameter" });
        return;
      }

      try {
        const rows = urlParam
          ? getHttpSamples({ fromMs, toMs, url: urlParam })
          : getHttpSamples({ fromMs, toMs });
        const mapped = rows.map((row) => ({
          ts: row.ts,
          url: row.url,
          status: row.status,
          ttfb_ms: row.ttfb_ms,
          total_ms: row.total_ms,
          bytes: row.bytes,
          success: row.success === 1 || row.success === true,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        log.error("Failed to query HTTP samples", error);
        sendJson(res, 500, { error: "Query failed" });
      }
      return;
    }

    if (method === "GET" && pathname.startsWith("/v1/api/traceroute/")) {
      const idPart = pathname.substring("/v1/api/traceroute/".length);
      const id = Number.parseInt(idPart, 10);
      if (!Number.isFinite(id) || id <= 0) {
        sendJson(res, 400, { error: "Invalid traceroute id" });
        return;
      }

      try {
        const row = getRunById(id);
        if (!row) {
          sendJson(res, 404, { error: "Traceroute not found" });
          return;
        }
        let hops = [];
        try {
          const parsed = JSON.parse(row.hops_json ?? "[]");
          if (Array.isArray(parsed)) {
            hops = parsed;
          }
        } catch (error) {
          hops = [];
        }
        sendJson(res, 200, {
          id: row.id,
          ts: row.ts,
          target: row.target,
          success: row.success,
          hops,
        });
      } catch (error) {
        log.error("Failed to load traceroute run", error);
        sendJson(res, 500, { error: "Query failed" });
      }
      return;
    }

    if (method === "GET" && pathname === "/") {
      sendHtml(res, 200, renderIndexHtml(appConfig));
      return;
    }

    sendText(res, 404, "Not found");
  };

  return { handler, liveMetrics };
}

export async function startServer({ host, port, db, signal, config, closeTimeoutMs = 1500 }) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const listenPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const listenHost = providedHost === "127.0.0.1" ? "127.0.0.1" : "127.0.0.1";

  const appConfig = getUiConfig({
    defaultTarget: UI_DEFAULT_TARGET,
    sparklineMinutes: UI_SPARKLINE_MINUTES,
    sseRetryMs: UI_SSE_RETRY_MS,
    thresholds: {
      p95: { warn: THRESH_P95_WARN_MS, crit: THRESH_P95_CRIT_MS },
      loss: { warn: THRESH_LOSS_WARN_PCT, crit: THRESH_LOSS_CRIT_PCT },
      dns: { warn: THRESH_DNS_WARN_MS, crit: THRESH_DNS_CRIT_MS },
      ttfb: { warn: THRESH_TTFB_WARN_MS, crit: THRESH_TTFB_CRIT_MS },
    },
  });

  const { handler, liveMetrics } = createRequestHandler(db, appConfig, {
    live: {
      pushIntervalMs: config?.liveMetrics?.pushIntervalMs,
      useWindows: config?.liveMetrics?.useWindows,
      pingTargets: config?.ping?.targets,
    },
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const sockets = new Set();
    let closeRequested = false;
    let signalHandler = null;
    let exportedClose = null;
    let settled = false;

    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const onError = (error) => {
      server.removeListener("listening", onListening);
      finishReject(error);
    };

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });

    const onListening = () => {
      server.removeListener("error", onError);
      const close = () => {
        if (closeRequested) {
          return Promise.resolve();
        }
        closeRequested = true;

        return new Promise((resolveClose, rejectClose) => {
          let completed = false;

          try {
            liveMetrics?.close();
          } catch (error) {
            log.warn("Failed to stop live metrics", error);
          }

          const timeout = setTimeout(() => {
            if (completed) {
              return;
            }
            completed = true;
            for (const socket of sockets) {
              try {
                socket.destroy();
              } catch (error) {
                // Ignore socket destroy errors during forced shutdown.
              }
            }
            resolveClose();
          }, closeTimeoutMs);
          timeout.unref?.();

          server.close((err) => {
            if (completed) {
              return;
            }
            completed = true;
            clearTimeout(timeout);
            if (err) {
              rejectClose(err);
            } else {
              resolveClose();
            }
          });
        });
      };

      exportedClose = close;

      finishResolve({
        close,
        server,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);

    if (signal) {
      const handleAbort = () => {
        if (exportedClose) {
          exportedClose().catch((error) => {
            log.warn("Failed to stop live metrics during abort", error);
          });
        } else {
          closeRequested = true;
          try {
            liveMetrics?.close();
          } catch (error) {
            log.warn("Failed to stop live metrics during abort", error);
          }
          server.close(() => {});
          finishReject(new Error("Server shutdown requested before start"));
        }
      };

      if (signal.aborted) {
        handleAbort();
      } else {
        signalHandler = handleAbort;
        signal.addEventListener("abort", signalHandler);
      }
    }

    server.once("close", () => {
      if (signal && signalHandler) {
        signal.removeEventListener("abort", signalHandler);
      }
      try {
        liveMetrics?.close();
      } catch (error) {
        log.warn("Failed to stop live metrics after close", error);
      }
    });
  });
}
