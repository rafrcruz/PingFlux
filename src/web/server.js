import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runTraceroute } from "../collectors/traceroute.js";
import { renderIndexPage } from "./index-page.js";
import { createLiveMetricsBroadcaster } from "./live-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const fsPromises = fs.promises;

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
});

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

async function tryServePublicAsset(res, pathname) {
  if (!pathname.startsWith("/public/")) {
    return false;
  }

  const relative = pathname.slice("/public/".length);
  if (!relative) {
    return false;
  }

  const normalized = path.normalize(relative).replace(/^\.\/+/, "");
  const resolvedPath = path.join(PUBLIC_DIR, normalized);
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return false;
  }

  try {
    const data = await fsPromises.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Length", data.length);
    res.end(data);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    console.error("[web] Failed to serve asset:", error);
    sendText(res, 500, "Failed to load asset");
    return true;
  }
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
        tracerouteLatestByTarget: db.prepare(
          "SELECT id, ts, target, hops_json, success FROM traceroute_run WHERE target = ? ORDER BY ts DESC LIMIT 1"
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

  const uiConfig = getUiConfig(appConfig);

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

    if (await tryServePublicAsset(res, parsedUrl.pathname)) {
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
      sendJson(res, 200, uiConfig);
      return;
    }

    if (method === "GET" && (parsedUrl.pathname === "/live/metrics" || parsedUrl.pathname === "/v1/live/metrics")) {
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

    if (
      method === "GET" &&
      (parsedUrl.pathname === "/api/ping/window" || parsedUrl.pathname === "/v1/api/ping/window")
    ) {
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

    if (
      method === "GET" &&
      (parsedUrl.pathname === "/api/dns" || parsedUrl.pathname === "/v1/api/dns")
    ) {
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

    if (
      method === "GET" &&
      (parsedUrl.pathname === "/api/http" || parsedUrl.pathname === "/v1/api/http")
    ) {
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

    if (method === "GET" && (parsedUrl.pathname === "/api/traceroute/latest" || parsedUrl.pathname === "/v1/api/traceroute/latest")) {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const rawTarget = parsedUrl.searchParams.get("target");
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (!target) {
        sendJson(res, 400, { error: "Target required" });
        return;
      }

      try {
        const row = statements.tracerouteLatestByTarget.get(target);
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

    if (method === "GET") {
      const tracerouteMatch = /^\/(?:v1\/)?api\/traceroute\/(\d+)$/.exec(parsedUrl.pathname);
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
      sendHtml(res, 200, renderIndexPage(uiConfig));
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


