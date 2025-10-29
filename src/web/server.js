import http from "http";
import { runTraceroute } from "../collectors/traceroute.js";
import { createLiveMetricsBroadcaster } from "./live-metrics.js";

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
const HEALTH_WINDOW_OPTIONS = Object.freeze(["1m", "5m", "1h"]);

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

function parseHealthWindow(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (HEALTH_WINDOW_OPTIONS.includes(normalized)) {
    return normalized;
  }
  return "1m";
}

function parseMinPoints(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

function describeWindowLabel(window) {
  switch (window) {
    case "1m":
      return "1 minuto";
    case "5m":
      return "5 minutos";
    case "1h":
      return "1 hora";
    default:
      return window;
  }
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
const HEALTH_EVAL_WINDOW = parseHealthWindow(process.env.HEALTH_EVAL_WINDOW);
const HEALTH_REQUIRE_MIN_POINTS = parseMinPoints(process.env.HEALTH_REQUIRE_MIN_POINTS);

function buildThresholdPair(warn, crit) {
  return {
    warn: parseFiniteNumber(warn),
    crit: parseFiniteNumber(crit),
  };
}

function getUiConfig(providedConfig) {
  const base = providedConfig && typeof providedConfig === "object" ? providedConfig : {};
  const thresholds = base.thresholds && typeof base.thresholds === "object" ? base.thresholds : {};
  const baseHealth = base.health && typeof base.health === "object" ? base.health : {};
  const healthWindow = parseHealthWindow(baseHealth.window ?? HEALTH_EVAL_WINDOW);
  const healthMinPoints = parseMinPoints(baseHealth.requireMinPoints ?? HEALTH_REQUIRE_MIN_POINTS);

  return {
    defaultTarget: typeof base.defaultTarget === "string" ? base.defaultTarget : UI_DEFAULT_TARGET,
    sparklineMinutes: parseSparklineMinutes(base.sparklineMinutes ?? UI_SPARKLINE_MINUTES),
    sseRetryMs: parseRetryInterval(base.sseRetryMs ?? UI_SSE_RETRY_MS),
    rangeOptions: Array.from(SPARKLINE_RANGE_OPTIONS),
    thresholds: {
      p95: buildThresholdPair(thresholds.p95?.warn ?? THRESH_P95_WARN_MS, thresholds.p95?.crit ?? THRESH_P95_CRIT_MS),
      loss: buildThresholdPair(thresholds.loss?.warn ?? THRESH_LOSS_WARN_PCT, thresholds.loss?.crit ?? THRESH_LOSS_CRIT_PCT),
      dns: buildThresholdPair(thresholds.dns?.warn ?? THRESH_DNS_WARN_MS, thresholds.dns?.crit ?? THRESH_DNS_CRIT_MS),
      ttfb: buildThresholdPair(thresholds.ttfb?.warn ?? THRESH_TTFB_WARN_MS, thresholds.ttfb?.crit ?? THRESH_TTFB_CRIT_MS),
    },
    health: {
      window: healthWindow,
      windowLabel: describeWindowLabel(healthWindow),
      requireMinPoints: healthMinPoints,
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

      .health-card {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 20px;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(15, 23, 42, 0.88);
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(6px);
      }

      .health-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }

      .health-status-group {
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .health-meta {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .health-meta strong {
        color: #f8fafc;
      }

      .health-title {
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      .health-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 150px;
        padding: 10px 18px;
        border-radius: 999px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 0.9rem;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: rgba(15, 23, 42, 0.85);
        color: #e2e8f0;
        transition: all 0.2s ease;
      }

      .health-badge.ok {
        border-color: rgba(34, 197, 94, 0.7);
        background: rgba(34, 197, 94, 0.16);
        color: #4ade80;
      }

      .health-badge.warn {
        border-color: rgba(234, 179, 8, 0.7);
        background: rgba(234, 179, 8, 0.16);
        color: #facc15;
      }

      .health-badge.crit {
        border-color: rgba(248, 113, 113, 0.8);
        background: rgba(248, 113, 113, 0.16);
        color: #f87171;
      }

      .health-badge.insufficient {
        border-color: rgba(148, 163, 184, 0.4);
        background: rgba(148, 163, 184, 0.12);
        color: rgba(203, 213, 225, 0.95);
      }

      .health-note {
        margin: 0;
        font-size: 0.88rem;
        color: rgba(203, 213, 225, 0.9);
      }

      .health-reasons {
        margin: 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 0.88rem;
        color: #e2e8f0;
      }

      .health-reasons li {
        list-style: disc;
      }

      .health-reasons li.warn {
        color: #facc15;
      }

      .health-reasons li.crit {
        color: #f87171;
      }

      .health-reasons li.muted {
        color: #94a3b8;
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

      .interpretation-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }

      .interpretation-card {
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 14px;
        padding: 16px;
        background: rgba(15, 23, 42, 0.74);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .interpretation-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .interpretation-header h3 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }

      .help-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.4);
        font-size: 0.75rem;
        font-weight: 600;
        color: rgba(148, 163, 184, 0.9);
        background: rgba(30, 41, 59, 0.9);
        cursor: help;
      }

      .interpretation-card p {
        margin: 0;
        color: rgba(226, 232, 240, 0.88);
        font-size: 0.92rem;
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

        .health-card {
          top: 0;
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
      <section id="health-panel" class="health-card" aria-live="polite">
        <div class="health-header">
          <div class="health-status-group">
            <span id="health-status" class="health-badge insufficient">Dados insuficientes</span>
            <div class="health-meta">
              <span class="health-title">Painel de Saúde</span>
              <span class="health-window">Janela avaliada: <strong id="health-window-label">${uiConfig.health.windowLabel}</strong></span>
            </div>
          </div>
          <span class="last-update">Última atualização: <strong id="health-last-update">—</strong></span>
        </div>
        <p id="health-note" class="health-note">Aguardando dados recentes · mín. ${uiConfig.health.requireMinPoints} pontos</p>
        <ul id="health-reasons" class="health-reasons">
          <li class="muted">Aguardando atualização do canal ao vivo.</li>
        </ul>
      </section>

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

      <section class="section-card" aria-label="Guia de interpretação das métricas">
        <div class="section-header">
          <h2>Como interpretar</h2>
        </div>
        <div class="interpretation-grid">
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>RTT p95</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="p95: 95% das amostras têm RTT ≤ este valor; sensível a picos.">?</span>
            </div>
            <p>Valor que 95% das amostras não ultrapassam; ótimo para identificar picos de latência.</p>
          </article>
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>RTT médio</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="RTT médio: tempo médio de resposta no último minuto.">?</span>
            </div>
            <p>Tempo médio de ida e volta no período; indica o comportamento geral das rotas.</p>
          </article>
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>Perda</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="Perda: % de pacotes que não retornaram no período.">?</span>
            </div>
            <p>Percentual de pacotes sem resposta; acima de 1% já pode degradar chamadas e APIs.</p>
          </article>
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>Disponibilidade</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="Disponibilidade: estimativa de 100 - perda; quanto maior, melhor.">?</span>
            </div>
            <p>Estimativa de 100 - perda; usada como visão geral da saúde de rede do alvo.</p>
          </article>
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>DNS Lookup</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="DNS lookup (1m): tempo médio de resolução DNS no último minuto.">?</span>
            </div>
            <p>Tempo para resolver o nome do host; latências altas atrasam o início das conexões.</p>
          </article>
          <article class="interpretation-card">
            <div class="interpretation-header">
              <h3>TTFB</h3>
              <span class="help-icon" role="img" aria-label="Ajuda" title="TTFB (1m): tempo médio até o primeiro byte nas verificações HTTP.">?</span>
            </div>
            <p>Tempo até o primeiro byte em checagens HTTP; mostra a latência do servidor final.</p>
          </article>
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
      const healthBadge = document.getElementById("health-status");
      const healthReasonsList = document.getElementById("health-reasons");
      const healthNoteEl = document.getElementById("health-note");
      const healthLastUpdateEl = document.getElementById("health-last-update");
      const healthWindowLabelEl = document.getElementById("health-window-label");
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
      const healthSettings = UI_CONFIG.health ?? {};
      const HEALTH_WINDOW_INFO = {
        "1m": { key: "win1m", field: "win1m_avg_ms", label: "1 minuto" },
        "5m": { key: "win5m", field: "win5m_avg_ms", label: "5 minutos" },
        "1h": { key: "win1h", field: "win1h_avg_ms", label: "1 hora" },
      };
      const requestedHealthWindow = typeof healthSettings.window === "string" ? healthSettings.window : "1m";
      const healthWindowInfo = HEALTH_WINDOW_INFO[requestedHealthWindow] ?? HEALTH_WINDOW_INFO["1m"];
      const parsedHealthMinPoints = Number.parseInt(healthSettings.requireMinPoints, 10);
      const healthMinPoints = Number.isFinite(parsedHealthMinPoints) && parsedHealthMinPoints >= 0
        ? parsedHealthMinPoints
        : 10;
      const healthWindowDescription = String(healthSettings.windowLabel ?? healthWindowInfo.label);

      if (healthWindowLabelEl) {
        healthWindowLabelEl.textContent = healthWindowDescription;
      }

      const history = new Map();
      let latestPayload = null;
      let eventSource = null;
      let reconnectTimer = null;

      function formatMs(value) {
        if (!Number.isFinite(value)) {
          return "—";
        }
        if (Math.abs(value) >= 100) {
          return `${Math.round(value)} ms`;
        }
        if (Math.abs(value) >= 10) {
          return `${value.toFixed(1)} ms`;
        }
        return `${value.toFixed(2)} ms`;
      }

      function formatPct(value) {
        if (!Number.isFinite(value)) {
          return "—";
        }
        if (Math.abs(value) >= 10) {
          return `${value.toFixed(1)} %`;
        }
        return `${value.toFixed(2)} %`;
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
          option.textContent = `${minutes} min`;
          if (minutes === state.rangeMinutes) {
            option.selected = true;
          }
          rangeSelect.appendChild(option);
        }
        sparklineRangeLabel.textContent = `Últimos ${state.rangeMinutes} minutos`;
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

      function evaluateHealth(payload) {
        const windowLabel = healthWindowDescription;
        const target = state.target;
        const reasons = [];
        let label = "DADOS INSUFICIENTES";
        let severityClass = "insufficient";
        let note = `Dados insuficientes para avaliar (0/${healthMinPoints} pontos na janela de ${windowLabel}).`;

        if (!target) {
          reasons.push({ text: "Selecione um alvo para avaliar a saúde.", className: "muted" });
          return { label, severityClass, reasons, note };
        }

        if (!payload) {
          reasons.push({ text: "Aguardando dados do canal ao vivo.", className: "muted" });
          return { label, severityClass, reasons, note };
        }

        const targetMetrics = payload?.ping?.[target];
        if (!targetMetrics) {
          reasons.push({ text: "Sem dados recentes de ping para o alvo selecionado.", className: "muted" });
          return { label, severityClass, reasons, note };
        }

        const windowMetrics = targetMetrics?.[healthWindowInfo.key] ?? {};
        const rawPoints = Number.parseInt(windowMetrics?.samples, 10);
        const pointsCount = Number.isFinite(rawPoints) && rawPoints >= 0 ? rawPoints : 0;

        if (pointsCount < healthMinPoints) {
          note = `Dados insuficientes para avaliar (${pointsCount}/${healthMinPoints} pontos na janela de ${windowLabel}).`;
          reasons.push({
            text: `Coleta insuficiente para avaliação confiável (${pointsCount}/${healthMinPoints} pontos).`,
            className: "muted",
          });
          return { label, severityClass, reasons, note };
        }

        const metrics = [
          { id: "p95", label: "RTT p95", value: normalizeNumber(windowMetrics?.p95_ms), thresholds: thresholds.p95, format: formatMs },
          { id: "loss", label: "Perda", value: normalizeNumber(windowMetrics?.loss_pct), thresholds: thresholds.loss, format: formatPct },
          { id: "dns", label: "DNS lookup", value: normalizeNumber(payload?.dns?.aggregate?.[healthWindowInfo.field]), thresholds: thresholds.dns, format: formatMs },
          { id: "ttfb", label: "TTFB", value: normalizeNumber(payload?.http?.aggregate?.ttfb?.[healthWindowInfo.field]), thresholds: thresholds.ttfb, format: formatMs },
        ];

        let worstLevel = 0;

        for (const metric of metrics) {
          const config = metric.thresholds ?? {};
          const warnThreshold = Number.isFinite(config.warn) ? config.warn : null;
          const critThreshold = Number.isFinite(config.crit) ? config.crit : null;
          const value = metric.value;
          let level = 0;

          if (value === null) {
            reasons.push({
              text: `${metric.label}: sem dados recentes na janela de ${windowLabel}.`,
              className: "warn",
            });
            level = 1;
          } else if (Number.isFinite(critThreshold) && value > critThreshold) {
            let message = `${metric.label} ${metric.format(value)} > ${metric.format(critThreshold)} (CRÍTICO)`;
            if (metric.id === "loss") {
              const availability = Math.max(0, Math.min(100, 100 - value));
              message += ` · disponibilidade ${formatPct(availability)}`;
            }
            reasons.push({ text: message, className: "crit" });
            level = 2;
          } else if (Number.isFinite(warnThreshold) && value > warnThreshold) {
            let message = `${metric.label} ${metric.format(value)} > ${metric.format(warnThreshold)} (ATENÇÃO)`;
            if (metric.id === "loss") {
              const availability = Math.max(0, Math.min(100, 100 - value));
              message += ` · disponibilidade ${formatPct(availability)}`;
            }
            reasons.push({ text: message, className: "warn" });
            level = 1;
          }

          if (level > worstLevel) {
            worstLevel = level;
          }
        }

        if (reasons.length === 0) {
          reasons.push({ text: "Todos os indicadores estão dentro dos limites configurados.", className: "muted" });
        }

        label = worstLevel >= 2 ? "CRÍTICO" : worstLevel === 1 ? "ATENÇÃO" : "OK";
        severityClass = worstLevel >= 2 ? "crit" : worstLevel === 1 ? "warn" : "ok";
        note = `Janela avaliada: ${windowLabel} · ${pointsCount} pontos analisados (mín. ${healthMinPoints})`;

        return { label, severityClass, reasons, note };
      }

      function updateHealthPanel(payload) {
        if (!healthBadge || !healthReasonsList || !healthNoteEl) {
          return;
        }
        const evaluation = evaluateHealth(payload);
        healthBadge.classList.remove("ok", "warn", "crit", "insufficient");
        healthBadge.classList.add(evaluation.severityClass);
        healthBadge.textContent = evaluation.label;
        healthNoteEl.textContent = evaluation.note;
        healthReasonsList.innerHTML = "";
        for (const reason of evaluation.reasons) {
          const item = document.createElement("li");
          item.textContent = reason.text;
          if (reason.className) {
            item.classList.add(reason.className);
          }
          healthReasonsList.appendChild(item);
        }
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
        sparklineSvg.setAttribute("aria-label", `Série histórica do alvo ${target}`);

        const width = 600;
        const height = 160;
        const padding = { top: 12, right: 12, bottom: 16, left: 12 };
        sparklineSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

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
              return `${command}${x},${y}`;
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
        let formatted = "—";
        if (Number.isFinite(timestamp)) {
          const formatter = new Intl.DateTimeFormat("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          formatted = formatter.format(new Date(timestamp));
        }
        if (lastUpdateEl) {
          lastUpdateEl.textContent = formatted;
        }
        if (healthLastUpdateEl) {
          healthLastUpdateEl.textContent = formatted;
        }
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
        updateHealthPanel(payload);
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
        eventSource = new EventSource("/live/metrics");

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
          updateHealthPanel(latestPayload);
          renderSparkline(state.target);
        }
      });

      updateRangeSelect();
      updateHealthPanel(null);
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
  const hasDb = db && typeof db.prepare === "function";
  const statements = hasDb
    ? {
        pingWindowAll: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, avg_ms, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? ORDER BY target ASC, ts_min ASC"
        ),
        pingWindowByTarget: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, avg_ms, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? AND target = ? ORDER BY ts_min ASC"
        ),
        dnsSamplesAll: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, success FROM dns_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        dnsSamplesByHostname: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, success FROM dns_sample WHERE ts BETWEEN ? AND ? AND hostname = ? ORDER BY ts ASC"
        ),
        httpSamplesAll: db.prepare(
          "SELECT ts, url, status, ttfb_ms, total_ms, bytes, success FROM http_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        httpSamplesByUrl: db.prepare(
          "SELECT ts, url, status, ttfb_ms, total_ms, bytes, success FROM http_sample WHERE ts BETWEEN ? AND ? AND url = ? ORDER BY ts ASC"
        ),
        tracerouteById: db.prepare(
          "SELECT id, ts, target, hops_json, success FROM traceroute_run WHERE id = ?"
        ),
      }
    : null;

  const liveMetrics = hasDb
    ? createLiveMetricsBroadcaster({
        db,
        config: {
          pushIntervalMs: options?.live?.pushIntervalMs,
          useWindows: options?.live?.useWindows,
          pingTargets: options?.live?.pingTargets,
        },
      })
    : null;

  const handler = async (req, res) => {
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

    if (method === "GET" && parsedUrl.pathname === "/health") {
      try {
        if (db) {
          db.prepare("SELECT 1").get();
        }
        sendJson(res, 200, { status: "ok" });
      } catch (error) {
        sendJson(res, 500, { status: "error", message: error?.message ?? "Unknown" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/ui-config") {
      sendJson(res, 200, getUiConfig(appConfig));
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/live/metrics") {
      if (!liveMetrics) {
        sendJson(res, 503, { error: "Live metrics unavailable" });
        return;
      }
      liveMetrics.handleRequest(req, res);
      return;
    }

    if (method === "POST" && parsedUrl.pathname === "/actions/traceroute") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = error?.message === "Body too large" ? 413 : 400;
        sendJson(res, status, { error: error?.message ?? "Invalid body" });
        return;
      }

      const payload = body && typeof body === "object" ? body : {};
      const rawTarget = typeof payload.target === "string" ? payload.target.trim() : "";
      const parsedMaxHops = Number.parseInt(payload.maxHops, 10);
      const parsedTimeoutMs = Number.parseInt(payload.timeoutMs, 10);
      const options = {};
      if (Number.isFinite(parsedMaxHops) && parsedMaxHops > 0) {
        options.maxHops = parsedMaxHops;
      }
      if (Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0) {
        options.timeoutMs = parsedTimeoutMs;
      }

      try {
        const result = await runTraceroute(rawTarget, options);
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

    if (method === "GET" && parsedUrl.pathname === "/api/ping/window") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawTarget = parsedUrl.searchParams.get("target");
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";

      try {
        if (target) {
          const rows = statements.pingWindowByTarget.all(fromMs, toMs, target);
          sendJson(res, 200, rows);
        } else {
          const rows = statements.pingWindowAll.all(fromMs, toMs);
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
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/dns") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawHostname = parsedUrl.searchParams.get("hostname");
      const hostname = typeof rawHostname === "string" ? rawHostname.trim() : "";

      try {
        const baseRows = hostname
          ? statements.dnsSamplesByHostname.all(fromMs, toMs, hostname)
          : statements.dnsSamplesAll.all(fromMs, toMs);
        const mapped = baseRows.map((row) => ({
          ts: row.ts,
          hostname: row.hostname,
          resolver: row.resolver,
          lookup_ms: row.lookup_ms,
          success: row.success === 1,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/http") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawUrlParam = parsedUrl.searchParams.get("url");
      const urlParam = typeof rawUrlParam === "string" ? rawUrlParam.trim() : "";

      try {
        const baseRows = urlParam
          ? statements.httpSamplesByUrl.all(fromMs, toMs, urlParam)
          : statements.httpSamplesAll.all(fromMs, toMs);
        const mapped = baseRows.map((row) => ({
          ts: row.ts,
          url: row.url,
          status: row.status,
          ttfb_ms: row.ttfb_ms,
          total_ms: row.total_ms,
          bytes: row.bytes,
          success: row.success === 1,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET") {
      const tracerouteMatch = /^\/api\/traceroute\/(\d+)$/.exec(parsedUrl.pathname);
      if (tracerouteMatch) {
        if (!statements) {
          sendJson(res, 500, { error: "Database unavailable" });
          return;
        }

        const id = Number.parseInt(tracerouteMatch[1], 10);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(res, 400, { error: "Invalid traceroute id" });
          return;
        }

        try {
          const row = statements.tracerouteById.get(id);
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
          sendJson(res, 500, { error: error?.message ?? "Query failed" });
        }
        return;
      }
    }

    if (method === "GET" && parsedUrl.pathname === "/") {
      sendHtml(res, 200, renderIndexHtml(appConfig));
      return;
    }

    sendText(res, 404, "Not found");
  };

  return { handler, liveMetrics };
}

export async function startServer({
  host,
  port,
  db,
  signal,
  config,
  closeTimeoutMs = 1500,
}) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const configPort = Number.parseInt(config?.web?.port, 10);
  const listenPort = Number.isFinite(parsedPort) && parsedPort > 0
    ? parsedPort
    : Number.isFinite(configPort) && configPort > 0
      ? configPort
      : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const configHost = typeof config?.web?.host === "string" ? config.web.host.trim() : "";
  const requestedHost = providedHost || configHost;
  const listenHost = requestedHost
    ? requestedHost === "localhost"
      ? "127.0.0.1"
      : requestedHost
    : "0.0.0.0";

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
            console.error("[web] Failed to stop live metrics:", error);
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
          exportedClose().catch(() => {});
        } else {
          closeRequested = true;
          try {
            liveMetrics?.close();
          } catch (error) {
            console.error("[web] Failed to stop live metrics during abort:", error);
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
        console.error("[web] Failed to stop live metrics after close:", error);
      }
    });
  });
}


