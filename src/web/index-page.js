const DEFAULT_TOOLTIPS = Object.freeze({
  pingP95: "p95: 95% das amostras tiveram RTT menor ou igual a este valor; bom para ver picos.",
  pingAvg: "RTT médio: tempo médio de resposta no último minuto.",
  pingLoss: "Perda: % de pacotes que não retornaram no período.",
  pingAvailability: "Disponibilidade: estimativa de 100 - perda; quanto maior, melhor.",
  dnsLookup: "DNS lookup (1m): tempo médio de resolução DNS no último minuto.",
  httpTtfb: "TTFB (1m): tempo médio até o primeiro byte nas verificações HTTP.",
});

function serializeConfig(config) {
  const safe = config && typeof config === "object" ? config : {};
  return JSON.stringify(safe)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function resolveSparklineMinutes(configMinutes) {
  const minutes = Number.parseInt(configMinutes, 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
}

export function renderIndexPage(uiConfig, options = {}) {
  const resolvedConfig = uiConfig && typeof uiConfig === "object" ? uiConfig : {};
  const tooltips = options.tooltips && typeof options.tooltips === "object"
    ? { ...DEFAULT_TOOLTIPS, ...options.tooltips }
    : DEFAULT_TOOLTIPS;
  const sparklineMinutes = resolveSparklineMinutes(resolvedConfig.sparklineMinutes);
  const encodedConfig = serializeConfig(resolvedConfig);

  const healthConfig = resolvedConfig.health && typeof resolvedConfig.health === "object" ? resolvedConfig.health : {};
  const healthWindowLabel = typeof healthConfig.windowLabel === "string" ? healthConfig.windowLabel : "1 minuto";
  const healthMinPoints = Number.isFinite(healthConfig.requireMinPoints) ? healthConfig.requireMinPoints : 10;

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
              <span class="health-window">Janela avaliada: <strong id="health-window-label">${healthWindowLabel}</strong></span>
            </div>
          </div>
          <span class="last-update">Última atualização: <strong id="health-last-update">—</strong></span>
        </div>
        <p id="health-note" class="health-note">Aguardando dados recentes · mín. ${healthMinPoints} pontos</p>
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
        <div class="kpi-card" data-kpi="ping-p95" title="${tooltips.pingP95}">
          <span class="kpi-label">RTT p95 (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-avg" title="${tooltips.pingAvg}">
          <span class="kpi-label">RTT médio (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-loss" title="${tooltips.pingLoss}">
          <span class="kpi-label">Perda (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="ping-availability" title="${tooltips.pingAvailability}">
          <span class="kpi-label">Disponibilidade (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="dns-lookup" title="${tooltips.dnsLookup}">
          <span class="kpi-label">DNS lookup (1m)</span>
          <span class="kpi-value">—</span>
        </div>
        <div class="kpi-card" data-kpi="http-ttfb" title="${tooltips.httpTtfb}">
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
          <span class="last-update" id="sparkline-range-label">Últimos ${sparklineMinutes} minutos</span>
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
      const UI_CONFIG = ${encodedConfig};
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
          tooltip: "${tooltips.pingP95}",
          thresholdKey: "p95",
          format: formatMs,
        },
        pingAvg: {
          card: document.querySelector('[data-kpi="ping-avg"]'),
          value: document.querySelector('[data-kpi="ping-avg"] .kpi-value'),
          tooltip: "${tooltips.pingAvg}",
          thresholdKey: null,
          format: formatMs,
        },
        pingLoss: {
          card: document.querySelector('[data-kpi="ping-loss"]'),
          value: document.querySelector('[data-kpi="ping-loss"] .kpi-value'),
          tooltip: "${tooltips.pingLoss}",
          thresholdKey: "loss",
          format: formatPct,
        },
        pingAvailability: {
          card: document.querySelector('[data-kpi="ping-availability"]'),
          value: document.querySelector('[data-kpi="ping-availability"] .kpi-value'),
          tooltip: "${tooltips.pingAvailability}",
          thresholdKey: "loss",
          format: formatPct,
        },
        dnsLookup: {
          card: document.querySelector('[data-kpi="dns-lookup"]'),
          value: document.querySelector('[data-kpi="dns-lookup"] .kpi-value'),
          tooltip: "${tooltips.dnsLookup}",
          thresholdKey: "dns",
          format: formatMs,
        },
        httpTtfb: {
          card: document.querySelector('[data-kpi="http-ttfb"]'),
          value: document.querySelector('[data-kpi="http-ttfb"] .kpi-value'),
          tooltip: "${tooltips.httpTtfb}",
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
