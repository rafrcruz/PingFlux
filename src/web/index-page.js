const DEFAULT_TOOLTIPS = Object.freeze({
  pingP95: "95% das amostras na janela visual têm RTT ≤ este valor.",
  pingP50: "Mediana do RTT considerando apenas a janela visual.",
  pingAvg: "RTT médio dentro da janela visual escolhida.",
  pingLoss: "% de pacotes sem resposta na janela selecionada.",
  pingAvailability: "100 - perda dentro da mesma janela visual.",
  dnsLookup: "Tempo médio de resolução DNS na janela visual.",
  httpTtfb: "TTFB médio observado recentemente (até 60m).",
  httpTotal: "Tempo total médio observado recentemente (até 60m).",
  noData: "Sem dados suficientes no período.",
});

function serializeConfig(config) {
  const safe = config && typeof config === "object" ? config : {};
  return JSON.stringify(safe)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function resolveRangeOptions() {
  return [1, 5, 15, 60];
}

export function renderIndexPage(uiConfig, options = {}) {
  const resolvedConfig = uiConfig && typeof uiConfig === "object" ? uiConfig : {};
  const tooltips =
    options.tooltips && typeof options.tooltips === "object"
      ? { ...DEFAULT_TOOLTIPS, ...options.tooltips }
      : DEFAULT_TOOLTIPS;
  const encodedConfig = serializeConfig({
    ...resolvedConfig,
    rangeOptions: resolveRangeOptions(),
  });
  const encodedTooltips = serializeConfig(tooltips);
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2338bdf8"/><stop offset="100%" stop-color="%2334d399"/></linearGradient></defs><rect width="64" height="64" rx="12" fill="%230b1120"/><path d="M8 34c6 0 6-18 12-18s6 32 12 32 6-44 12-44 6 38 12 38" fill="none" stroke="url(%23g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const faviconHref = `data:image/svg+xml,${encodeURIComponent(faviconSvg)}`;

  const themeBootstrap = `(()=>{try{const t=localStorage.getItem('pingflux-theme')==='light'?'light':'dark';document.documentElement.dataset.theme=t;document.documentElement.classList.add('theme-'+t);}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.classList.add('theme-dark');}})();`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PingFlux · Observabilidade em tempo real</title>
    <meta name="theme-color" content="#0b1120" />
    <link rel="icon" type="image/svg+xml" href="${faviconHref}" />
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
      <header class="app-hero" role="banner">
        <!-- Hero reorganizado para destacar título e estado em tempo real -->
        <div class="hero-top">
          <div class="brand" aria-label="PingFlux">
            <span class="brand-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" focusable="false">
                <path d="M8 34c6 0 6-18 12-18s6 32 12 32 6-44 12-44 6 38 12 38" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <div class="brand-text">
              <h1 class="brand-title">
                <span class="brand-title-main">PingFlux</span>
                <span class="brand-title-divider" aria-hidden="true">–</span>
                <span class="brand-title-tagline">Live Network Intelligence</span>
              </h1>
              <p class="brand-subtitle">Observabilidade contínua de latência, perda e disponibilidade.</p>
            </div>
          </div>
          <div class="hero-actions">
            <button id="themeToggle" class="toggle-theme" aria-label="Alternar tema" aria-live="polite">
              <span class="icon moon" aria-hidden="true"></span>
              <span class="icon sun" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <div class="hero-meta">
          <div class="live-indicator" role="status" aria-live="polite">
            <span id="connectionDot" class="status-dot status-dot--connecting" aria-hidden="true"></span>
            <span id="connectionText">Conectando…</span>
          </div>
          <time id="lastUpdate" class="last-update" datetime="">Última atualização: —</time>
        </div>
        <section class="controls" role="region" aria-label="Controles do dashboard">
          <!-- A janela visual selecionada abaixo atualiza KPIs, gráfico principal e severidade -->
          <label class="control select-control">
            <span class="control-label">Alvo de ping</span>
            <div class="target-status-row">
              <select id="targetSelect" aria-label="Selecionar alvo de ping" disabled></select>
              <span id="pingModeIndicator" class="badge badge-mode" hidden>ICMP</span>
            </div>
          </label>
          <div class="control range-control" role="group" aria-label="Janela visual">
            <span class="control-label">Janela visual</span>
            <div id="rangeButtons" class="range-buttons" role="group"></div>
          </div>
        </section>
      </header>

      <section class="kpi-section" aria-label="Indicadores principais">
        <!-- Grid principal de KPIs com 6 cards fixos -->
        <div class="kpi-grid">
          <article class="kpi-card" data-kpi="ping-p95" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 19h16M4 14l4-4 4 4 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT p95</span>
                  <button class="kpi-help" type="button" data-tooltip="pingP95" aria-label="Ajuda RTT p95">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-p95">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="ping-p50" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 17l6-6 4 4 6-10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT p50</span>
                  <button class="kpi-help" type="button" data-tooltip="pingP50" aria-label="Ajuda RTT p50">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-p50">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="ping-avg" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 13l4-6 4 3 4-7 4 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">RTT médio</span>
                  <button class="kpi-help" type="button" data-tooltip="pingAvg" aria-label="Ajuda RTT médio">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-avg">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="ping-loss" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M19 5l-7 14-4-7-5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">Perda</span>
                  <button class="kpi-help" type="button" data-tooltip="pingLoss" aria-label="Ajuda perda">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-loss">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="ping-availability" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M12 2v4m0 12v4m-8-8h4m8 0h4m-3.5-6.5l-2.8 2.8M8.3 8.3L5.5 5.5m0 12.9l2.8-2.8m8.9 0l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">Disponibilidade</span>
                  <button class="kpi-help" type="button" data-tooltip="pingAvailability" aria-label="Ajuda disponibilidade">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="ping-availability">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="dns-lookup" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M3 5h8v6H3zm10 0h8v6h-8zM3 13h8v6H3zm10 6v-6h8v6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">DNS lookup</span>
                  <button class="kpi-help" type="button" data-tooltip="dnsLookup" aria-label="Ajuda DNS">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="dns-lookup">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Janela de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="http-ttfb" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M4 7h16M6 12h12M8 17h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">HTTP TTFB</span>
                  <button class="kpi-help" type="button" data-tooltip="httpTtfb" aria-label="Ajuda HTTP TTFB">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="http-ttfb">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Média de 1 minuto</div>
          </article>

          <article class="kpi-card" data-kpi="http-total" data-loading="true">
            <div class="kpi-header">
              <div class="kpi-label-group">
                <span class="kpi-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false"><path d="M5 5h14v6H5zm0 8h9v6H5zm11 0h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <div>
                  <span class="kpi-title">HTTP total</span>
                  <button class="kpi-help" type="button" data-tooltip="httpTotal" aria-label="Ajuda HTTP total">?</button>
                </div>
              </div>
              <div class="kpi-trend" data-trend="http-total">
                <span class="trend-arrow" aria-hidden="true"></span>
                <span class="trend-label">—</span>
              </div>
            </div>
            <div class="kpi-value" data-value>—</div>
            <div class="kpi-sub" data-sub>Média de 1 minuto</div>
          </article>
        </div>
      </section>

      <section id="networkStatusBar" class="network-status" role="status" aria-live="polite">
        <!-- Barra de estado dinâmico da rede -->
        <span id="networkStatusText">Avaliando condições da rede…</span>
      </section>

      <main class="dashboard-layout" id="dashboardRoot">
        <section class="panel panel-large trend-panel" aria-label="Tendência de latência e perda">
            <div class="panel-header">
              <h2>Latência e perda</h2>
              <div class="panel-actions">
                <button id="resetZoom" class="ghost-button" type="button">Reset zoom</button>
              </div>
            </div>
          <div id="latencyChart" class="chart chart-large" role="img" aria-label="Gráfico de RTT"></div>
        </section>

        <div class="detail-grid" role="region" aria-label="Detalhes complementares">
          <section class="panel panel-medium" aria-label="Heatmap RTT" data-heatmap-panel data-compact-hidden>
            <div class="panel-header">
              <h2>Heatmap RTT p95</h2>
            </div>
            <div id="heatmapChart" class="chart chart-medium" role="img" aria-label="Heatmap RTT"></div>
          </section>

          <section class="panel panel-gauge" aria-label="Disponibilidade">
            <div class="panel-header">
              <h2>Disponibilidade</h2>
              <span class="panel-subtitle">Média móvel de 1 minuto</span>
            </div>
            <div id="availabilityGauge" class="chart chart-gauge" role="img" aria-label="Gauge de disponibilidade"></div>
          </section>

          <section class="panel panel-mini" aria-label="DNS Lookup">
            <div class="panel-header">
              <h2>DNS Lookup</h2>
              <span class="panel-subtitle">Média móvel de 1 minuto</span>
            </div>
            <div id="dnsGauge" class="chart chart-gauge" role="img" aria-label="Gauge de tempo de lookup DNS"></div>
          </section>
        </div>

        <div class="diagnostics-grid" role="region" aria-label="Diagnósticos HTTP e eventos">
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
              <span class="panel-subtitle">Média móvel de 1 minuto</span>
            </div>
            <div id="httpGauge" class="chart chart-gauge" role="img" aria-label="Gauge de tempo total HTTP"></div>
          </section>

          <section class="panel panel-events" aria-label="Eventos e alertas">
            <div class="panel-header">
              <h2>Eventos recentes</h2>
            </div>
            <ul id="eventList" class="event-list" aria-live="polite"></ul>
          </section>
        </div>

        <section class="panel panel-traceroute support-panel" aria-label="Último traceroute" data-compact-hidden>
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
