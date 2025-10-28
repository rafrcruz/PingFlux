import http from "http";
import { runTraceroute } from "../collectors/traceroute.js";

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
const RAW_UI_DEFAULT_RANGE = String(process.env.UI_DEFAULT_RANGE ?? "").trim().toLowerCase();
const UI_DEFAULT_RANGE = RANGE_OPTIONS.includes(RAW_UI_DEFAULT_RANGE) ? RAW_UI_DEFAULT_RANGE : "1h";
const UI_DEFAULT_TARGET = String(process.env.UI_DEFAULT_TARGET ?? "").trim();

function renderIndexHtml() {
  const appConfig = {
    defaultTarget: UI_DEFAULT_TARGET,
    defaultRange: UI_DEFAULT_RANGE,
    ranges: RANGE_OPTIONS,
  };

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PingFlux</title>
    <style>
      :root {
        color-scheme: dark light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.4;
      }

      body {
        margin: 0;
        padding: 0;
        background: #0d1017;
        color: #f3f5f9;
      }

      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }

      header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 24px;
      }

      h1 {
        margin: 0;
        font-size: 2rem;
      }

      form {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: flex-end;
      }

      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.9rem;
      }

      input[type="text"],
      select {
        padding: 6px 10px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(17, 22, 31, 0.7);
        color: inherit;
        min-width: 140px;
      }

      button {
        padding: 8px 16px;
        border-radius: 4px;
        border: none;
        background: #2563eb;
        color: white;
        cursor: pointer;
        font-size: 0.95rem;
      }

      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }

      .card {
        background: rgba(15, 18, 27, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 16px;
        margin-top: 24px;
      }

      .chart-container {
        width: 100%;
        height: 320px;
        position: relative;
      }

      svg {
        width: 100%;
        height: 100%;
        display: block;
      }

      .message {
        margin-top: 12px;
        font-size: 0.95rem;
        color: #facc15;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }

      .summary-item {
        background: rgba(255, 255, 255, 0.04);
        border-radius: 6px;
        padding: 12px;
      }

      .summary-label {
        font-size: 0.8rem;
        color: rgba(243, 245, 249, 0.7);
      }

      .summary-value {
        font-size: 1.2rem;
        font-weight: 600;
      }

      .table-container {
        overflow-x: auto;
        margin-top: 12px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 6px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        font-size: 0.85rem;
        text-align: left;
      }

      th {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.75rem;
        color: rgba(243, 245, 249, 0.7);
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>PingFlux</h1>
        <p>Monitoramento simples de RTT por alvo.</p>
      </header>
      <form id="controls" autocomplete="off">
        <label>
          Target
          <input type="text" name="target" id="target" list="target-options" placeholder="ex: 8.8.8.8" />
          <datalist id="target-options"></datalist>
        </label>
        <label>
          Range
          <select name="range" id="range">
            ${RANGE_OPTIONS.map((range) => `<option value="${range}">${range}</option>`).join("")}
          </select>
        </label>
        <button type="submit" id="submit">Atualizar</button>
        <button type="button" id="run-traceroute">Run traceroute</button>
      </form>
      <p class="message" id="message"></p>
      <section class="card">
        <div class="chart-container">
          <svg id="chart" viewBox="0 0 600 320" role="img" aria-label="Gráfico de RTT"></svg>
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Resumo</h2>
        <div class="summary-grid">
          <div class="summary-item">
            <div class="summary-label">Loss médio (%)</div>
            <div class="summary-value" id="summary-loss">--</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">P95 mais recente (ms)</div>
            <div class="summary-value" id="summary-p95">--</div>
          </div>
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Traceroute</h2>
        <p class="message" id="traceroute-status"></p>
        <div class="table-container" id="traceroute-table-container">
          <table id="traceroute-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">IP</th>
                <th scope="col">RTT1 (ms)</th>
                <th scope="col">RTT2 (ms)</th>
                <th scope="col">RTT3 (ms)</th>
              </tr>
            </thead>
            <tbody id="traceroute-tbody"></tbody>
          </table>
        </div>
      </section>
    </main>
    <script type="module">
      const APP_CONFIG = ${JSON.stringify(appConfig)};

      const RANGE_OPTIONS = APP_CONFIG.ranges;
      const DEFAULT_RANGE = APP_CONFIG.defaultRange || "1h";
      const DEFAULT_TARGET = APP_CONFIG.defaultTarget || "";

      const form = document.getElementById("controls");
      const targetInput = document.getElementById("target");
      const targetDatalist = document.getElementById("target-options");
      const rangeSelect = document.getElementById("range");
      const submitButton = document.getElementById("submit");
      const messageEl = document.getElementById("message");
      const chartSvg = document.getElementById("chart");
      const summaryLoss = document.getElementById("summary-loss");
      const summaryP95 = document.getElementById("summary-p95");
      const tracerouteButton = document.getElementById("run-traceroute");
      const tracerouteStatus = document.getElementById("traceroute-status");
      const tracerouteTableContainer = document.getElementById("traceroute-table-container");
      const tracerouteTbody = document.getElementById("traceroute-tbody");

      function parseInitialState() {
        const params = new URLSearchParams(window.location.search);
        let range = params.get("range")?.toLowerCase() || "";
        if (!RANGE_OPTIONS.includes(range)) {
          range = RANGE_OPTIONS.includes(DEFAULT_RANGE) ? DEFAULT_RANGE : "1h";
        }

        let target = params.get("target")?.trim() || "";
        if (!target) {
          target = DEFAULT_TARGET;
        }

        return { range, target };
      }

      function setMessage(text, tone = "info") {
        messageEl.textContent = text || "";
        messageEl.style.color = tone === "error" ? "#f97316" : tone === "muted" ? "rgba(243,245,249,0.7)" : "#facc15";
      }

      function setTracerouteStatus(text, tone = "info") {
        tracerouteStatus.textContent = text || "";
        tracerouteStatus.style.color =
          tone === "error"
            ? "#f97316"
            : tone === "muted"
            ? "rgba(243,245,249,0.7)"
            : "#facc15";
      }

      function formatHopMetric(value) {
        if (value === null || value === undefined) {
          return "*";
        }

        const num = Number(value);
        if (!Number.isFinite(num)) {
          return "*";
        }

        if (num >= 100) {
          return num.toFixed(0);
        }
        if (num >= 10) {
          return num.toFixed(1);
        }
        return num.toFixed(2);
      }

      function renderTracerouteHops(hops) {
        tracerouteTbody.innerHTML = "";
        if (!hops || hops.length === 0) {
          tracerouteTableContainer.style.display = "none";
          return;
        }

        tracerouteTableContainer.style.display = "";
        const fragment = document.createDocumentFragment();
        for (const hop of hops) {
          const row = document.createElement("tr");

          const hopCell = document.createElement("td");
          hopCell.textContent = hop?.hop ?? "";
          row.appendChild(hopCell);

          const ipCell = document.createElement("td");
          ipCell.textContent = hop?.ip || "*";
          row.appendChild(ipCell);

          const rtt1Cell = document.createElement("td");
          rtt1Cell.textContent = formatHopMetric(hop?.rtt1_ms);
          row.appendChild(rtt1Cell);

          const rtt2Cell = document.createElement("td");
          rtt2Cell.textContent = formatHopMetric(hop?.rtt2_ms);
          row.appendChild(rtt2Cell);

          const rtt3Cell = document.createElement("td");
          rtt3Cell.textContent = formatHopMetric(hop?.rtt3_ms);
          row.appendChild(rtt3Cell);

          fragment.appendChild(row);
        }

        tracerouteTbody.appendChild(fragment);
      }

      function extractTargets(payload) {
        if (!payload) {
          return [];
        }
        if (Array.isArray(payload)) {
          const unique = new Set();
          for (const row of payload) {
            if (row?.target) {
              unique.add(String(row.target));
            }
          }
          return Array.from(unique);
        }
        if (typeof payload === "object") {
          return Object.keys(payload);
        }
        return [];
      }

      function coerceNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }

      function formatNumber(value, digits = 2) {
        if (value === null || value === undefined || Number.isNaN(value)) {
          return "--";
        }
        return Number(value).toFixed(digits);
      }

      function renderSummary(rows) {
        if (!rows || rows.length === 0) {
          summaryLoss.textContent = "--";
          summaryP95.textContent = "--";
          return;
        }

        const totalLoss = rows.reduce((acc, row) => acc + (coerceNumber(row.loss_pct) ?? 0), 0);
        const avgLoss = rows.length > 0 ? totalLoss / rows.length : null;
        const latest = rows[rows.length - 1];
        const latestP95 = coerceNumber(latest?.p95_ms);

        summaryLoss.textContent = avgLoss !== null ? formatNumber(avgLoss, 2) : "--";
        summaryP95.textContent = latestP95 !== null ? formatNumber(latestP95, 0) : "--";
      }

      function renderChart(rows) {
        chartSvg.innerHTML = "";
        if (!rows || rows.length === 0) {
          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", "50%");
          text.setAttribute("y", "50%");
          text.setAttribute("dominant-baseline", "middle");
          text.setAttribute("text-anchor", "middle");
          text.textContent = "Sem dados no período selecionado.";
          chartSvg.appendChild(text);
          return;
        }

        const padding = { top: 16, right: 32, bottom: 32, left: 48 };
        const width = 600;
        const height = 320;
        chartSvg.setAttribute("viewBox", "0 0 " + width + " " + height);

        const points = rows.map((row) => ({
          ts: coerceNumber(row.ts_min),
          p50: coerceNumber(row.p50_ms),
          p95: coerceNumber(row.p95_ms),
        })).filter((row) => row.ts !== null);

        if (points.length === 0) {
          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", "50%");
          text.setAttribute("y", "50%");
          text.setAttribute("dominant-baseline", "middle");
          text.setAttribute("text-anchor", "middle");
          text.textContent = "Sem dados no período selecionado.";
          chartSvg.appendChild(text);
          return;
        }

        const minTs = points.reduce((min, p) => (p.ts < min ? p.ts : min), points[0].ts);
        const maxTs = points.reduce((max, p) => (p.ts > max ? p.ts : max), points[0].ts);
        const minValue = points.reduce((min, p) => {
          const values = [p.p50, p.p95].filter((v) => v !== null);
          if (values.length === 0) {
            return min;
          }
          const localMin = Math.min(...values);
          return localMin < min ? localMin : min;
        }, Number.POSITIVE_INFINITY);
        const maxValue = points.reduce((max, p) => {
          const values = [p.p50, p.p95].filter((v) => v !== null);
          if (values.length === 0) {
            return max;
          }
          const localMax = Math.max(...values);
          return localMax > max ? localMax : max;
        }, Number.NEGATIVE_INFINITY);

        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", "50%");
          text.setAttribute("y", "50%");
          text.setAttribute("dominant-baseline", "middle");
          text.setAttribute("text-anchor", "middle");
          text.textContent = "Sem dados no período selecionado.";
          chartSvg.appendChild(text);
          return;
        }

        const rangeTs = maxTs - minTs || 1;
        const rangeValue = maxValue - minValue || 1;

        function projectX(ts) {
          return padding.left + ((ts - minTs) / rangeTs) * (width - padding.left - padding.right);
        }

        function projectY(value) {
          const normalized = (value - minValue) / rangeValue;
          return height - padding.bottom - normalized * (height - padding.top - padding.bottom);
        }

        const axis = document.createElementNS("http://www.w3.org/2000/svg", "g");
        axis.setAttribute("stroke", "rgba(255,255,255,0.2)");
        axis.setAttribute("fill", "none");

        const xAxis = document.createElementNS("http://www.w3.org/2000/svg", "line");
        xAxis.setAttribute("x1", padding.left);
        xAxis.setAttribute("x2", width - padding.right);
        xAxis.setAttribute("y1", height - padding.bottom);
        xAxis.setAttribute("y2", height - padding.bottom);
        axis.appendChild(xAxis);

        const yAxis = document.createElementNS("http://www.w3.org/2000/svg", "line");
        yAxis.setAttribute("x1", padding.left);
        yAxis.setAttribute("x2", padding.left);
        yAxis.setAttribute("y1", padding.top);
        yAxis.setAttribute("y2", height - padding.bottom);
        axis.appendChild(yAxis);

        chartSvg.appendChild(axis);

        const gridLines = 4;
        for (let i = 0; i <= gridLines; i += 1) {
          const fraction = i / gridLines;
          const y = padding.top + (1 - fraction) * (height - padding.top - padding.bottom);
          const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
          grid.setAttribute("x1", padding.left);
          grid.setAttribute("x2", width - padding.right);
          grid.setAttribute("y1", y);
          grid.setAttribute("y2", y);
          grid.setAttribute("stroke", "rgba(255,255,255,0.08)");
          chartSvg.appendChild(grid);

          const labelValue = minValue + fraction * rangeValue;
          const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
          label.setAttribute("x", padding.left - 8);
          label.setAttribute("y", y + 4);
          label.setAttribute("text-anchor", "end");
          label.setAttribute("fill", "rgba(255,255,255,0.7)");
          label.setAttribute("font-size", "11");
          label.textContent = formatNumber(labelValue, 0);
          chartSvg.appendChild(label);
        }

        const timestampFormatter = new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "2-digit",
        });

        const xLabels = 4;
        for (let i = 0; i <= xLabels; i += 1) {
          const fraction = i / xLabels;
          const ts = minTs + fraction * rangeTs;
          const x = projectX(ts);
          const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
          label.setAttribute("x", x);
          label.setAttribute("y", height - padding.bottom + 20);
          label.setAttribute("text-anchor", "middle");
          label.setAttribute("fill", "rgba(255,255,255,0.7)");
          label.setAttribute("font-size", "11");
          label.textContent = timestampFormatter.format(new Date(ts));
          chartSvg.appendChild(label);
        }

        function buildPolyline(values, color) {
          const pointsAttr = values
            .map((point) => {
              const value = point.value ?? null;
              if (value === null) {
                return null;
              }
              const x = projectX(point.ts).toFixed(2);
              const y = projectY(value).toFixed(2);
              return x + "," + y;
            })
            .filter(Boolean)
            .join(" ");

          const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
          polyline.setAttribute("fill", "none");
          polyline.setAttribute("stroke-width", "2.5");
          polyline.setAttribute("stroke", color);
          polyline.setAttribute("points", pointsAttr);
          return polyline;
        }

        const p50Series = points.map((p) => ({ ts: p.ts, value: p.p50 }));
        const p95Series = points.map((p) => ({ ts: p.ts, value: p.p95 }));

        chartSvg.appendChild(buildPolyline(p50Series, "#38bdf8"));
        chartSvg.appendChild(buildPolyline(p95Series, "#f97316"));

        const legend = document.createElementNS("http://www.w3.org/2000/svg", "g");
        legend.setAttribute("transform", "translate(" + padding.left + ", " + padding.top + ")");

        function legendItem(label, color, index) {
          const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
          group.setAttribute("transform", "translate(" + index * 140 + ", 0)");

          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", 0);
          line.setAttribute("x2", 24);
          line.setAttribute("y1", 0);
          line.setAttribute("y2", 0);
          line.setAttribute("stroke", color);
          line.setAttribute("stroke-width", "3");
          group.appendChild(line);

          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", 32);
          text.setAttribute("y", 4);
          text.setAttribute("fill", "rgba(255,255,255,0.9)");
          text.setAttribute("font-size", "12");
          text.textContent = label;
          group.appendChild(text);

          return group;
        }

        legend.appendChild(legendItem("p50 ms", "#38bdf8", 0));
        legend.appendChild(legendItem("p95 ms", "#f97316", 1));
        chartSvg.appendChild(legend);
      }

      function updateTargetOptions(list) {
        targetDatalist.innerHTML = "";
        list.forEach((target) => {
          const option = document.createElement("option");
          option.value = target;
          targetDatalist.appendChild(option);
        });
      }

      async function fetchWindow(range, target) {
        const params = new URLSearchParams({ range });
        if (target) {
          params.set("target", target);
        }

        const response = await fetch("/api/ping/window?" + params.toString());
        if (!response.ok) {
          throw new Error("Falha ao carregar dados (" + response.status + ")");
        }
        const payload = await response.json();

        const targets = extractTargets(payload);
        let resolvedTarget = target;
        let rows;

        if (!resolvedTarget && targets.length > 0) {
          resolvedTarget = targets[0];
        }

        if (Array.isArray(payload)) {
          rows = payload;
          if (!resolvedTarget && rows.length > 0 && rows[0].target) {
            resolvedTarget = String(rows[0].target);
          }
        } else if (resolvedTarget) {
          rows = payload?.[resolvedTarget] ?? [];
        } else {
          rows = [];
        }

        return { rows, targets, target: resolvedTarget ?? "" };
      }

      function updateQueryString(range, target) {
        const url = new URL(window.location.href);
        url.searchParams.set("range", range);
        if (target) {
          url.searchParams.set("target", target);
        } else {
          url.searchParams.delete("target");
        }
        window.history.replaceState(null, "PingFlux", url.toString());
      }

      async function load(range, target) {
        setMessage("Carregando dados...", "muted");
        submitButton.disabled = true;

        try {
          const { rows, targets, target: resolvedTarget } = await fetchWindow(range, target);
          updateTargetOptions(targets);
          targetInput.value = resolvedTarget;
          rangeSelect.value = range;
          updateQueryString(range, resolvedTarget);

          if (!rows || rows.length === 0) {
            setMessage("Sem dados no período selecionado.", "muted");
          } else {
            setMessage("");
          }

          renderChart(rows);
          renderSummary(rows);
        } catch (error) {
          console.error(error);
          setMessage(error.message || "Erro ao carregar dados.", "error");
          renderChart([]);
          renderSummary([]);
        } finally {
          submitButton.disabled = false;
        }
      }

      setTracerouteStatus("Execute um traceroute para ver os hops.", "muted");
      tracerouteTableContainer.style.display = "none";

      const initial = parseInitialState();
      rangeSelect.value = initial.range;
      targetInput.value = initial.target;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const range = rangeSelect.value;
        const target = targetInput.value.trim();
        load(range, target);
      });

      tracerouteButton.addEventListener("click", async () => {
        const target = targetInput.value.trim();
        tracerouteButton.disabled = true;
        setTracerouteStatus("Executando traceroute...", "muted");
        renderTracerouteHops([]);

        try {
          const response = await fetch("/actions/traceroute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target }),
          });

          if (!response.ok) {
            let errorMessage = "Falha ao iniciar traceroute.";
            try {
              const payload = await response.json();
              if (payload?.error) {
                errorMessage = String(payload.error);
              }
            } catch (error) {
              // Ignore body parsing errors.
            }
            throw new Error(errorMessage);
          }

          const actionResult = await response.json();
          const rawId = actionResult?.id;
          if (rawId === null || rawId === undefined || rawId === "") {
            throw new Error("Resposta inválida da ação de traceroute.");
          }

          const id = String(rawId);
          setTracerouteStatus("Carregando resultado...", "muted");

          const resultResponse = await fetch("/api/traceroute/" + encodeURIComponent(id));
          if (!resultResponse.ok) {
            throw new Error("Falha ao carregar resultado do traceroute.");
          }

          const resultPayload = await resultResponse.json();
          const hops = Array.isArray(resultPayload?.hops) ? resultPayload.hops : [];
          renderTracerouteHops(hops);

          if (!hops.length) {
            setTracerouteStatus(
              resultPayload?.success === 1
                ? "Nenhum hop retornado."
                : "Traceroute finalizado sem dados.",
              resultPayload?.success === 1 ? "muted" : "error"
            );
          } else if (resultPayload?.success === 1) {
            setTracerouteStatus("Traceroute concluído.", "muted");
          } else {
            setTracerouteStatus("Traceroute finalizado com falha.", "error");
          }
        } catch (error) {
          renderTracerouteHops([]);
          setTracerouteStatus(error.message || "Falha ao executar traceroute.", "error");
        } finally {
          tracerouteButton.disabled = false;
        }
      });

      load(initial.range, initial.target);
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

function createRequestHandler(db) {
  const hasDb = db && typeof db.prepare === "function";
  const statements = hasDb
    ? {
        pingWindowAll: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? ORDER BY target ASC, ts_min ASC"
        ),
        pingWindowByTarget: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? AND target = ? ORDER BY ts_min ASC"
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

  return async (req, res) => {
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
      sendHtml(res, 200, renderIndexHtml());
      return;
    }

    sendText(res, 404, "Not found");
  };
}

export async function startServer({ host, port, db, signal, closeTimeoutMs = 1500 }) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const listenPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const listenHost = providedHost === "127.0.0.1" ? "127.0.0.1" : "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler(db));
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
    });
  });
}
