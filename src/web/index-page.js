const DEFAULT_TOOLTIPS = Object.freeze({
  pingP95: "RTT p95: 95% das amostras ficaram abaixo deste valor.",
  pingP50: "RTT p50: mediana do RTT para o alvo no último minuto.",
  pingAvg: "RTT médio no último minuto.",
  pingLoss: "Perda de pacotes no último minuto.",
  pingAvailability: "Disponibilidade estimada: 100 - perda (quanto maior, melhor).",
  dnsLookup: "Tempo médio de resolução DNS no último minuto.",
  httpTtfb: "TTFB médio (1m): tempo até o primeiro byte nas verificações HTTP.",
  httpTotal: "Tempo total médio (1m) das verificações HTTP.",
});

function serializeConfig(config) {
  const safe = config && typeof config === "object" ? config : {};
  return JSON.stringify(safe)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function resolveRangeOptions(config) {
  const defaults = [5, 10, 15, 30];
  const provided = Array.isArray(config?.rangeOptions) ? config.rangeOptions : [];
  const values = provided
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const merged = [...new Set([...defaults, ...values])].sort((a, b) => a - b);
  return merged.length ? merged : defaults;
}

export function renderIndexPage(uiConfig, options = {}) {
  const resolvedConfig = uiConfig && typeof uiConfig === "object" ? uiConfig : {};
  const tooltips = options.tooltips && typeof options.tooltips === "object"
    ? { ...DEFAULT_TOOLTIPS, ...options.tooltips }
    : DEFAULT_TOOLTIPS;
  const encodedConfig = serializeConfig({
    ...resolvedConfig,
    rangeOptions: resolveRangeOptions(resolvedConfig),
  });
  const encodedTooltips = serializeConfig(tooltips);

  const themeBootstrap = `(()=>{try{const t=localStorage.getItem('pingflux-theme')==='light'?'light':'dark';document.documentElement.dataset.theme=t;document.documentElement.classList.add('theme-'+t);}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.classList.add('theme-dark');}})();`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PingFlux · Observabilidade em tempo real</title>
    <meta name="theme-color" content="#0b1120" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
    <script>${themeBootstrap}</script>
    <link rel="stylesheet" href="/public/dashboard.css" />
    <script defer src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
    <script type="module" defer src="/public/dashboard.js"></script>
  </head>
  <body>
    <div class="page-shell">
      <header class="app-header" role="banner">
        <div class="brand" aria-label="PingFlux">
          <span class="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64" focusable="false">
              <path d="M8 34c6 0 6-18 12-18s6 32 12 32 6-44 12-44 6 38 12 38" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <div class="brand-text">
            <span class="brand-title">PingFlux</span>
            <span class="brand-subtitle">Live Network Intelligence</span>
          </div>
        </div>
        <div class="header-actions">
          <button id="themeToggle" class="toggle-theme" aria-label="Alternar tema" aria-live="polite">
            <span class="icon moon" aria-hidden="true"></span>
            <span class="icon sun" aria-hidden="true"></span>
          </button>
          <div class="live-indicator" role="status" aria-live="polite">
            <span id="connectionDot" class="status-dot status-dot--connecting" aria-hidden="true"></span>
            <span id="connectionText">Conectando…</span>
          </div>
          <time id="lastUpdate" class="last-update" datetime="">Última atualização: —</time>
        </div>
      </header>

      <section class="controls" role="region" aria-label="Controles do dashboard">
        <label class="control select-control">
          <span class="control-label">Alvo de ping</span>
          <select id="targetSelect" aria-label="Selecionar alvo de ping" disabled></select>
        </label>
        <div class="control range-control" role="group" aria-label="Janela visual">
          <span class="control-label">Janela visual</span>
          <div id="rangeButtons" class="range-buttons" role="group"></div>
        </div>
        <button id="pauseStream" class="control ghost-button" aria-pressed="false">Pausar stream</button>
      </section>

      <section class="kpi-section" aria-label="Indicadores principais">
        <div class="kpi-grid">
          <article class="kpi-card" data-kpi="ping-p95">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 19h16M4 14l4-4 4 4 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT p95 (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="pingP95" aria-label="Ajuda RTT p95">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-p95">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="ping-p95">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="ping-p50">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 17l6-6 4 4 6-10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT p50 (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="pingP50" aria-label="Ajuda RTT p50">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-p50">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="ping-p50">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="ping-avg">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 13l4-6 4 3 4-7 4 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT médio (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="pingAvg" aria-label="Ajuda RTT médio">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-avg">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="ping-avg">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="ping-loss">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M19 5l-7 14-4-7-5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">Perda (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="pingLoss" aria-label="Ajuda perda">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-loss">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="ping-loss">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="ping-availability">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M12 2v4m0 12v4m-8-8h4m8 0h4m-3.5-6.5l-2.8 2.8M8.3 8.3L5.5 5.5m0 12.9l2.8-2.8m8.9 0l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">Disponibilidade (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="pingAvailability" aria-label="Ajuda disponibilidade">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-availability">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="ping-availability">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="dns-lookup">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M3 5h8v6H3zm10 0h8v6h-8zM3 13h8v6H3zm10 6v-6h8v6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">DNS lookup (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="dnsLookup" aria-label="Ajuda DNS">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="dns-lookup">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="dns-lookup">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="http-ttfb">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">TTFB (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="httpTtfb" aria-label="Ajuda TTFB">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="http-ttfb">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="http-ttfb">Sem dados</span>
            </div>
          </article>

          <article class="kpi-card" data-kpi="http-total">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 4h7l3 6h6l-3 10H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">HTTP total (1m)</span>
                  <button class="kpi-help" type="button" data-tooltip="httpTotal" aria-label="Ajuda tempo total">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="http-total">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-foot">
              <span class="kpi-sub" data-sub="http-total">Sem dados</span>
            </div>
          </article>
        </div>
      </section>

      <main class="dashboard-grid" id="dashboardRoot">
        <section class="panel panel-large" aria-label="Séries temporais de ping">
          <div class="panel-header">
            <h2>Latência e perda</h2>
            <div class="panel-actions">
              <label class="checkbox">
                <input type="checkbox" id="lossToggle" checked aria-label="Alternar série de perda" />
                <span>Exibir perda (%)</span>
              </label>
              <button id="resetZoom" class="ghost-button" type="button">Reset zoom</button>
            </div>
          </div>
          <div id="latencyChart" class="chart chart-large" role="img" aria-label="Gráfico de RTT"></div>
        </section>

        <section class="panel panel-medium" aria-label="Heatmap RTT">
          <div class="panel-header">
            <h2>Heatmap RTT p95</h2>
          </div>
          <div id="heatmapChart" class="chart chart-medium" role="img" aria-label="Heatmap RTT"></div>
        </section>

        <section class="panel panel-gauge" aria-label="Disponibilidade">
          <div class="panel-header">
            <h2>Disponibilidade (1m)</h2>
          </div>
          <div id="availabilityGauge" class="chart chart-gauge" role="img" aria-label="Gauge de disponibilidade"></div>
        </section>

        <section class="panel panel-mini" aria-label="DNS Lookup">
          <div class="panel-header">
            <h2>DNS Lookup</h2>
            <span class="panel-subtitle">Últimos 60 min</span>
          </div>
          <div id="dnsSparkline" class="chart chart-mini" role="img" aria-label="Série de lookup DNS"></div>
        </section>

        <section class="panel panel-mini" aria-label="HTTP TTFB">
          <div class="panel-header">
            <h2>HTTP TTFB</h2>
            <span class="panel-subtitle">Últimos 60 min</span>
          </div>
          <div id="httpTtfbSparkline" class="chart chart-mini" role="img" aria-label="Série de TTFB"></div>
        </section>

        <section class="panel panel-mini" aria-label="HTTP Tempo total">
          <div class="panel-header">
            <h2>HTTP Tempo total</h2>
            <span class="panel-subtitle">Últimos 60 min</span>
          </div>
          <div id="httpTotalSparkline" class="chart chart-mini" role="img" aria-label="Série de tempo total HTTP"></div>
        </section>

        <section class="panel panel-events" aria-label="Eventos e alertas">
          <div class="panel-header">
            <h2>Eventos recentes</h2>
          </div>
          <ul id="eventList" class="event-list" aria-live="polite"></ul>
        </section>

        <section class="panel panel-traceroute" aria-label="Último traceroute">
          <div class="panel-header">
            <div>
              <h2>Último traceroute</h2>
              <span class="panel-subtitle" id="tracerouteMeta">Sem execuções</span>
            </div>
            <button id="tracerouteTrigger" class="primary-button" type="button">Rodar novamente</button>
          </div>
          <div id="tracerouteTimeline" class="traceroute-timeline" role="list"></div>
        </section>
      </main>
    </div>

    <script>window.UI_CONFIG = ${encodedConfig}; window.UI_STRINGS = ${encodedTooltips};</script>
  </body>
</html>`;
}
