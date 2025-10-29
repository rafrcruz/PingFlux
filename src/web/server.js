import http from "http";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { runTraceroute } from "../collectors/traceroute.js";
import { createLiveMetricsBroadcaster } from "./live-metrics.js";
import { renderIndexPage } from "./index-page.js";
import * as logger from "../utils/logger.js";

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

function sendJson(res, statusCode, payload, options = {}) {
  const { method } = options;
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  if (method === "HEAD") {
    res.end();
    return;
  }
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
    logger.error("web", "Failed to serve asset", error);
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

const MINUTE_MS = 60 * 1000;
const PING_WINDOW_TABLES = Object.freeze([
  "ping_window_1m",
  "ping_window_5m",
  "ping_window_15m",
  "ping_window_60m",
]);
const RANGE_TO_WINDOW_TABLE = Object.freeze({
  "1m": "ping_window_1m",
  "5m": "ping_window_5m",
  "15m": "ping_window_15m",
  "60m": "ping_window_60m",
  "1h": "ping_window_60m",
});
const DEFAULT_WINDOW_TABLE = "ping_window_1m";
const RANGE_TO_DURATION_MS = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "60m": 60 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "6h": 6 * 60 * MINUTE_MS,
  "24h": 24 * 60 * 60 * 1000,
};

const FALLBACK_PING_TARGETS = ["3.174.59.117", "8.8.8.8", "1.1.1.1"];

function parseTargetList(raw) {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const ENV_PING_TARGETS = parseTargetList(process.env.PING_TARGETS);
const UI_DEFAULT_TARGET = ENV_PING_TARGETS[0] || FALLBACK_PING_TARGETS[0];
const SPARKLINE_RANGE_OPTIONS = Object.freeze([5, 10, 15]);
const HEALTH_WINDOW_OPTIONS = Object.freeze(["1m", "5m", "1h"]);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return Boolean(fallback);
}

function probePortAvailability(port, host) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    let settled = false;

    const cleanup = () => {
      tester.removeListener("error", onError);
      tester.removeListener("listening", onListening);
    };

    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onListening = () => {
      if (settled) {
        return;
      }
      settled = true;
      const address = tester.address();
      cleanup();
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        const actualPort =
          typeof address === "object" && address ? address.port : port;
        resolve(actualPort);
      });
    };

    tester.once("error", onError);
    tester.once("listening", onListening);
    tester.listen({ port, host, exclusive: true });
  });
}

async function resolveListenPort(port, host, { allowFallback = true } = {}) {
  try {
    const resolvedPort = await probePortAvailability(port, host);
    return { port: resolvedPort, conflict: false };
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }
    if (!allowFallback) {
      throw error;
    }
    try {
      const fallbackPort = await probePortAvailability(0, host);
      return { port: fallbackPort, conflict: true, conflictError: error };
    } catch {
      throw error;
    }
  }
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

function parseAlpha(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 && num < 1 ? num : null;
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
const UI_EVENTS_DEDUP_MS = parsePositiveInt(
  process.env.UI_EVENTS_DEDUP_MS ?? process.env.EVENTS_DEDUP_MS,
  30000
);
const UI_EVENTS_COOLDOWN_MS = parsePositiveInt(
  process.env.UI_EVENTS_COOLDOWN_MS ?? process.env.EVENTS_COOLDOWN_MS,
  10000
);
const UI_EWMA_ALPHA = (() => {
  const value = process.env.UI_EWMA_ALPHA;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 && num < 1 ? num : null;
})();
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
const UI_TRACEROUTE_MAX_AGE_MIN = parsePositiveInt(
  process.env.UI_TRACEROUTE_MAX_AGE_MIN ?? process.env.TRACEROUTE_MAX_AGE_MIN,
  10
);

function buildThresholdPair(warn, crit) {
  return {
    warn: parseFiniteNumber(warn),
    crit: parseFiniteNumber(crit),
  };
}

// Derives warn/critical thresholds from a single alert value.
// Used during server start-up to configure UI thresholds from .env values.
function deriveAlertThreshold(alertValue, fallbackWarn, fallbackCrit) {
  const critValue = parseFiniteNumber(alertValue);
  if (critValue != null) {
    const warnValue = critValue * 0.75;
    return {
      warn: warnValue,
      crit: critValue,
    };
  }
  return buildThresholdPair(fallbackWarn, fallbackCrit);
}

function getUiConfig(providedConfig) {
  const base = providedConfig && typeof providedConfig === "object" ? providedConfig : {};
  const thresholds = base.thresholds && typeof base.thresholds === "object" ? base.thresholds : {};
  const baseHealth = base.health && typeof base.health === "object" ? base.health : {};
  const healthWindow = parseHealthWindow(baseHealth.window ?? HEALTH_EVAL_WINDOW);
  const healthMinPoints = parseMinPoints(baseHealth.requireMinPoints ?? HEALTH_REQUIRE_MIN_POINTS);
  const providedTargets = Array.isArray(base.targets) ? base.targets : [];
  const normalizedTargets = providedTargets
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const requestedDefault = typeof base.defaultTarget === "string" ? base.defaultTarget.trim() : "";
  const defaultTarget = requestedDefault || normalizedTargets[0] || UI_DEFAULT_TARGET || "";
  const eventsDedupMs = parsePositiveInt(
    base.eventsDedupMs ?? base.EVENTS_DEDUP_MS,
    UI_EVENTS_DEDUP_MS
  );
  const eventsCooldownMs = parsePositiveInt(
    base.eventsCooldownMs ?? base.EVENTS_COOLDOWN_MS,
    UI_EVENTS_COOLDOWN_MS
  );
  const tracerouteMaxAgeMin = parsePositiveInt(
    base.tracerouteMaxAgeMin ?? base.TRACEROUTE_MAX_AGE_MIN,
    UI_TRACEROUTE_MAX_AGE_MIN
  );
  const ewmaAlpha = parseAlpha(base.uiEwmaAlpha ?? base.UI_EWMA_ALPHA ?? UI_EWMA_ALPHA);
  const heatmapEnabled = parseBooleanFlag(
    base.UI_ENABLE_HEATMAP ?? base.enableHeatmap ?? process.env.UI_ENABLE_HEATMAP,
    false
  );

  return {
    defaultTarget,
    DEFAULT_TARGET: defaultTarget,
    eventsDedupMs,
    EVENTS_DEDUP_MS: eventsDedupMs,
    eventsCooldownMs,
    EVENTS_COOLDOWN_MS: eventsCooldownMs,
    tracerouteMaxAgeMin,
    TRACEROUTE_MAX_AGE_MIN: tracerouteMaxAgeMin,
    sparklineMinutes: parseSparklineMinutes(base.sparklineMinutes ?? UI_SPARKLINE_MINUTES),
    sseRetryMs: parseRetryInterval(base.sseRetryMs ?? UI_SSE_RETRY_MS),
    rangeOptions: Array.from(SPARKLINE_RANGE_OPTIONS),
    uiEwmaAlpha: ewmaAlpha,
    UI_EWMA_ALPHA: ewmaAlpha,
    UI_ENABLE_HEATMAP: heatmapEnabled,
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
    health: {
      window: healthWindow,
      windowLabel: describeWindowLabel(healthWindow),
      requireMinPoints: healthMinPoints,
    },
  };
}

function resolveRangeWindow(rawRange) {
  const normalized = typeof rawRange === "string" ? rawRange.trim().toLowerCase() : "";
  const rangeKey = RANGE_TO_DURATION_MS[normalized] ? normalized : "60m";
  const durationMs = RANGE_TO_DURATION_MS[rangeKey];
  const nowMs = Date.now();
  const fromMs = nowMs - durationMs;

  const windowTable = RANGE_TO_WINDOW_TABLE[rangeKey] ?? null;

  return { fromMs, toMs: nowMs, rangeKey, durationMs, windowTable };
}

function preparePingWindowStatements(db) {
  const result = Object.create(null);
  for (const table of PING_WINDOW_TABLES) {
    const selectBase = `
      SELECT ts_min, target, sent, received, loss_pct, avg_ms, p50_ms, p95_ms, stdev_ms, availability_pct, status
      FROM ${table}
    `;
    result[table] = {
      rangeAll: db.prepare(
        `${selectBase} WHERE ts_min BETWEEN ? AND ? ORDER BY target ASC, ts_min ASC`
      ),
      rangeByTarget: db.prepare(
        `${selectBase} WHERE ts_min BETWEEN ? AND ? AND target = ? ORDER BY ts_min ASC`
      ),
      recent: db.prepare(`${selectBase} WHERE ts_min >= ? ORDER BY ts_min ASC`),
    };
  }
  return result;
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampPercentage(value) {
  const num = normalizeNumber(value);
  if (num == null) {
    return null;
  }
  if (num < 0) {
    return 0;
  }
  if (num > 100) {
    return 100;
  }
  return num;
}

function computePercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = values
    .map((value) => Number(value))
    .filter((num) => Number.isFinite(num))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sorted[lowerIndex];
  const upperValue = sorted[upperIndex];
  if (lowerIndex === upperIndex) {
    return lowerValue;
  }
  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function computePingWindowSummary(samples, aggregates, { preferAggregated = false } = {}) {
  const result = {
    win_p95_ms: null,
    win_p50_ms: null,
    win_avg_ms: null,
    win_loss_pct: null,
    win_samples: 0,
    win_availability_pct: null,
    status: null,
  };

  const safeAggregates = Array.isArray(aggregates) ? aggregates : [];
  if (preferAggregated && safeAggregates.length > 0) {
    const latest = safeAggregates.reduce((acc, entry) => {
      if (!acc) {
        return entry;
      }
      const currentTs = Number(entry?.ts_min);
      const accTs = Number(acc?.ts_min);
      return Number.isFinite(currentTs) && (!Number.isFinite(accTs) || currentTs > accTs) ? entry : acc;
    });

    const status = typeof latest?.status === "string" && latest.status.trim().length ? latest.status : "ok";
    result.status = status;
    result.win_samples = Number.isFinite(Number(latest?.sent)) ? Number(latest.sent) : 0;
    if (status === "ok") {
      result.win_loss_pct = clampPercentage(latest?.loss_pct);
      result.win_avg_ms = normalizeNumber(latest?.avg_ms);
      result.win_p50_ms = normalizeNumber(latest?.p50_ms);
      result.win_p95_ms = normalizeNumber(latest?.p95_ms);
      result.win_availability_pct = clampPercentage(latest?.availability_pct ?? (result.win_loss_pct == null ? null : 100 - result.win_loss_pct));
    }

    return result;
  }

  const safeSamples = Array.isArray(samples) ? samples : [];
  const successLatencies = safeSamples
    .filter((row) => Number(row.success) === 1)
    .map((row) => normalizeNumber(row.rtt_ms))
    .filter((value) => value != null);

  if (successLatencies.length > 0) {
    result.win_p95_ms = computePercentile(successLatencies, 0.95);
    result.win_p50_ms = computePercentile(successLatencies, 0.5);
    const sum = successLatencies.reduce((acc, value) => acc + value, 0);
    result.win_avg_ms = sum / successLatencies.length;
  }

  let totalSent = 0;
  let totalReceived = 0;
  let weightedLatencySum = 0;
  let weightedLatencyCount = 0;

  for (const row of safeAggregates) {
    const sent = Number(row?.sent);
    const received = Number(row?.received);
    if (Number.isFinite(sent)) {
      totalSent += sent;
    }
    if (Number.isFinite(received)) {
      totalReceived += received;
    }
    const avgValue = normalizeNumber(row?.avg_ms);
    if (avgValue != null && Number.isFinite(received) && received > 0) {
      weightedLatencySum += avgValue * received;
      weightedLatencyCount += received;
    }
  }

  if (weightedLatencyCount > 0) {
    result.win_avg_ms = weightedLatencySum / weightedLatencyCount;
  }

  if (totalSent > 0) {
    const effectiveReceived = Number.isFinite(totalReceived) ? totalReceived : 0;
    result.win_loss_pct = ((totalSent - effectiveReceived) / totalSent) * 100;
    result.win_samples = totalSent;
  } else {
    result.win_samples = successLatencies.length;
  }

  result.status = result.win_samples > 0 ? "ok" : "insufficient";
  result.win_loss_pct = clampPercentage(result.win_loss_pct);
  result.win_avg_ms = normalizeNumber(result.win_avg_ms);
  result.win_p50_ms = normalizeNumber(result.win_p50_ms);
  result.win_p95_ms = normalizeNumber(result.win_p95_ms);
  result.win_availability_pct = clampPercentage(
    result.win_loss_pct == null ? null : 100 - result.win_loss_pct
  );

  return result;
}

// Normalizes traceroute hops stored in the database to the API schema.
// Executed whenever clients request the latest traceroute (roughly every few minutes).
function normalizeTracerouteHop(raw, index) {
  const hopNumber = Number(raw?.hop ?? raw?.index);
  const hop = Number.isFinite(hopNumber) && hopNumber > 0 ? hopNumber : index + 1;
  const ipCandidates = [raw?.ip, raw?.address, raw?.ipAddress]
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

  return { hop, ip: ip || "*", rtt_ms: rtt ?? null };
}

// Builds the traceroute payload expected by the UI and API consumers.
// Runs on demand whenever a traceroute result is fetched.
function buildTraceroutePayload(row) {
  const ts = Number(row?.ts);
  let parsedHops = [];
  if (typeof row?.hops_json === "string") {
    try {
      const raw = JSON.parse(row.hops_json);
      if (Array.isArray(raw)) {
        parsedHops = raw;
      }
    } catch (error) {
      parsedHops = [];
    }
  }

  const normalizedHops = parsedHops.map((hop, index) => normalizeTracerouteHop(hop, index));

  return {
    id: Number.isFinite(Number(row?.id)) ? Number(row.id) : null,
    target: typeof row?.target === "string" ? row.target : null,
    success: Number(row?.success) === 1,
    ts: Number.isFinite(ts) ? ts : null,
    executed_at: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    hops: normalizedHops,
  };
}

function createRequestHandler(db, appConfig, options = {}) {
  const hasDb = db && typeof db.prepare === "function";
  const statements = hasDb
    ? {
        pingWindowTables: preparePingWindowStatements(db),
        pingSamplesByTargetRange: db.prepare(
          "SELECT ts, target, rtt_ms, success FROM ping_sample WHERE ts BETWEEN ? AND ? AND target = ? ORDER BY ts ASC"
        ),
        pingSamplesRangeAll: db.prepare(
          "SELECT ts, target, rtt_ms, success FROM ping_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        dnsSamplesAll: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, lookup_ms_hot, lookup_ms_cold, success, success_hot, success_cold FROM dns_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        dnsSamplesByHostname: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, lookup_ms_hot, lookup_ms_cold, success, success_hot, success_cold FROM dns_sample WHERE ts BETWEEN ? AND ? AND hostname = ? ORDER BY ts ASC"
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

  const healthStatements = hasDb
    ? {
        db: db.prepare("SELECT 1"),
        ping: db.prepare("SELECT 1 FROM ping_sample LIMIT 1"),
        dns: db.prepare("SELECT 1 FROM dns_sample LIMIT 1"),
        http: db.prepare("SELECT 1 FROM http_sample LIMIT 1"),
      }
    : {};
  const availableTargets = Array.from(
    new Set(
      (Array.isArray(options?.availableTargets) ? options.availableTargets : [])
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    )
  );
  const features = options?.features ?? {};
  const previousHealthState = new Map();
  const liveConfig = options?.live ?? {};
  const liveEnabled = liveConfig.enabled !== false;

  const runStatement = (statement) => {
    if (!statement) {
      throw new Error("Statement unavailable");
    }
    statement.get();
  };

  const evaluateComponent = (name, enabled, fn) => {
    if (!enabled) {
      previousHealthState.set(name, "ok");
      return "ok";
    }

    let status = "ok";
    try {
      fn();
    } catch (error) {
      status = "error";
      if (previousHealthState.get(name) !== "error") {
        logger.error("web", `Health component '${name}' failed`, error);
      }
    }

    previousHealthState.set(name, status);
    return status;
  };

  const computeHealth = () => {
    const components = {};

    components.db = evaluateComponent("db", true, () => {
      if (!hasDb) {
        throw new Error("Database unavailable");
      }
      runStatement(healthStatements.db);
    });

    const canQuery = components.db === "ok" && hasDb;

    const pingEnabled = features.enablePing !== false;
    components.ping = canQuery
      ? evaluateComponent("ping", pingEnabled, () => {
          runStatement(healthStatements.ping);
        })
      : evaluateComponent("ping", pingEnabled, () => {
          throw new Error("Database unavailable");
        });

    const dnsEnabled = features.enableDns !== false;
    components.dns = canQuery
      ? evaluateComponent("dns", dnsEnabled, () => {
          runStatement(healthStatements.dns);
        })
      : evaluateComponent("dns", dnsEnabled, () => {
          throw new Error("Database unavailable");
        });

    const httpEnabled = features.enableHttp !== false;
    components.http = canQuery
      ? evaluateComponent("http", httpEnabled, () => {
          runStatement(healthStatements.http);
        })
      : evaluateComponent("http", httpEnabled, () => {
          throw new Error("Database unavailable");
        });

    components.live = evaluateComponent("live", liveEnabled, () => {
      if (!liveMetrics) {
        throw new Error("Live metrics unavailable");
      }
    });

    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";

    return { components, status };
  };

  const liveMetrics = hasDb
    ? createLiveMetricsBroadcaster({
        db,
        config: {
          pushIntervalMs: options?.live?.pushIntervalMs,
          useWindows: options?.live?.useWindows,
          pingTargets: options?.live?.pingTargets,
          staleMs: options?.live?.staleMs,
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

    if (await tryServePublicAsset(res, parsedUrl.pathname)) {
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/health") {
      const { components, status } = computeHealth();
      const payload = {
        status,
        uptime_s: Number(process.uptime().toFixed(3)),
        components,
        targets_active: availableTargets.length,
        timestamp: new Date().toISOString(),
      };
      const statusCode = status === "ok" ? 200 : 503;
      sendJson(res, statusCode, payload);
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/ui-config") {
      sendJson(res, 200, getUiConfig(appConfig));
      return;
    }

    if (
      method === "GET" &&
      (parsedUrl.pathname === "/live/metrics" || parsedUrl.pathname === "/v1/live/metrics")
    ) {
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
      (method === "GET" || method === "HEAD") &&
      (parsedUrl.pathname === "/api/ping/window" || parsedUrl.pathname === "/v1/api/ping/window")
    ) {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" }, { method });
        return;
      }

      const { fromMs, toMs, rangeKey, durationMs, windowTable } = resolveRangeWindow(
        parsedUrl.searchParams.get("range")
      );
      const rawTarget = parsedUrl.searchParams.get("target");
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      const windowStatementsMap = statements.pingWindowTables ?? {};
      const resolvedTable = windowTable && windowStatementsMap[windowTable] ? windowTable : DEFAULT_WINDOW_TABLE;
      const windowStatements = windowStatementsMap[resolvedTable] ?? null;
      const preferAggregated = Boolean(windowTable && windowStatements && windowTable === resolvedTable);

      try {
        if (method === "HEAD") {
          sendJson(res, 200, { ok: true }, { method });
          return;
        }

        if (target) {
          const aggregates = windowStatements
            ? windowStatements.rangeByTarget.all(fromMs, toMs, target)
            : [];
          const sampleRows = statements.pingSamplesByTargetRange
            ? statements.pingSamplesByTargetRange.all(fromMs, toMs, target)
            : [];
          const samples = sampleRows.map((row) => ({
            ts: Number(row.ts),
            target: row.target,
            success: Number(row.success) === 1,
            rtt_ms: normalizeNumber(row.rtt_ms),
          }));
          const summary = computePingWindowSummary(samples, aggregates, { preferAggregated });
          sendJson(
            res,
            200,
            {
              target,
              range: rangeKey,
              windowMs: durationMs,
              summary,
              aggregates,
              samples,
            },
            { method }
          );
        } else {
          const aggregates = windowStatements ? windowStatements.rangeAll.all(fromMs, toMs) : [];
          const aggregateByTarget = new Map();
          for (const row of aggregates) {
            if (!aggregateByTarget.has(row.target)) {
              aggregateByTarget.set(row.target, []);
            }
            aggregateByTarget.get(row.target).push(row);
          }
          const sampleRows = statements.pingSamplesRangeAll
            ? statements.pingSamplesRangeAll.all(fromMs, toMs)
            : [];
          const samplesByTarget = new Map();
          for (const row of sampleRows) {
            if (!samplesByTarget.has(row.target)) {
              samplesByTarget.set(row.target, []);
            }
            samplesByTarget.get(row.target).push({
              ts: Number(row.ts),
              target: row.target,
              success: Number(row.success) === 1,
              rtt_ms: normalizeNumber(row.rtt_ms),
            });
          }

          const response = Object.create(null);
          for (const [entryTarget, list] of aggregateByTarget.entries()) {
            const samples = samplesByTarget.get(entryTarget) ?? [];
            response[entryTarget] = {
              target: entryTarget,
              range: rangeKey,
              windowMs: durationMs,
              summary: computePingWindowSummary(samples, list, { preferAggregated }),
              aggregates: list,
              samples,
            };
          }
          sendJson(res, 200, response, { method });
        }
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" }, { method });
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
          ts: Number(row.ts),
          hostname: row.hostname,
          resolver: row.resolver,
          lookup_ms: normalizeNumber(row.lookup_ms),
          lookup_ms_hot: normalizeNumber(row.lookup_ms_hot),
          lookup_ms_cold: normalizeNumber(row.lookup_ms_cold),
          success: Number(row.success) === 1,
          success_hot:
            row.success_hot === undefined || row.success_hot === null
              ? null
              : Number(row.success_hot) === 1,
          success_cold:
            row.success_cold === undefined || row.success_cold === null
              ? null
              : Number(row.success_cold) === 1,
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

    if (
      (method === "GET" || method === "HEAD") &&
      (parsedUrl.pathname === "/api/traceroute/latest" ||
        parsedUrl.pathname === "/v1/api/traceroute/latest")
    ) {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" }, { method });
        return;
      }

      const rawTarget = parsedUrl.searchParams.get("target");
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (!target) {
        sendJson(res, 400, { error: "Target required" }, { method });
        return;
      }

      try {
        const row = statements.tracerouteLatestByTarget.get(target);
        if (!row) {
          sendJson(res, 404, { error: "Traceroute not found" }, { method });
          return;
        }

        const payload = buildTraceroutePayload(row);
        sendJson(res, 200, payload, { method });
      } catch (error) {
        sendJson(
          res,
          500,
          { error: error?.message ?? "Query failed" },
          { method }
        );
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

          const payload = buildTraceroutePayload(row);
          sendJson(res, 200, payload);
        } catch (error) {
          sendJson(res, 500, { error: error?.message ?? "Query failed" });
        }
        return;
      }
    }

    if (method === "GET" && parsedUrl.pathname === "/") {
      const uiConfig = getUiConfig(appConfig);
      sendHtml(res, 200, renderIndexPage(uiConfig));
      return;
    }

    sendText(res, 404, "Not found");
  };

  return { handler, liveMetrics };
}

export async function startServer({ host, port, db, signal, config, closeTimeoutMs = 1500 }) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const configPort = Number.parseInt(
    config?.server?.port ?? config?.web?.port,
    10
  );
  let listenPort =
    Number.isFinite(parsedPort) && parsedPort > 0
      ? parsedPort
      : Number.isFinite(configPort) && configPort > 0
        ? configPort
        : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const configHostValue = config?.server?.host ?? config?.web?.host;
  const configHost = typeof configHostValue === "string" ? configHostValue.trim() : "";
  const requestedHost = providedHost || configHost;
  const listenHost = requestedHost
    ? requestedHost === "localhost"
      ? "127.0.0.1"
      : requestedHost
    : "0.0.0.0";

  const allowPortFallback = parseBooleanFlag(process.env.PORT_FALLBACK, true);
  const requestedPort = listenPort;

  try {
    const { port: resolvedPort, conflict } = await resolveListenPort(listenPort, listenHost, {
      allowFallback: allowPortFallback,
    });
    listenPort = resolvedPort;
    if (conflict && resolvedPort !== requestedPort) {
      logger.warn(
        "web",
        `Port ${requestedPort} already in use on ${listenHost}. Using fallback port ${listenPort}. Set PORT_FALLBACK=off to disable auto selection.`
      );
    }
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      const message = `Port ${requestedPort} is already in use on ${listenHost}. Set PORT to a free port or stop the conflicting process.`;
      const enhancedError = new Error(message);
      enhancedError.code = error.code;
      enhancedError.cause = error;
      throw enhancedError;
    }
    throw error;
  }

  const portConflict = listenPort !== requestedPort;

  const configuredTargets = Array.isArray(config?.ping?.targets) ? config.ping.targets : [];
  const normalizedTargets = configuredTargets
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const availableTargets = normalizedTargets.length ? normalizedTargets : FALLBACK_PING_TARGETS;
  const defaultTarget = availableTargets[0] || UI_DEFAULT_TARGET;

  const appConfig = getUiConfig({
    defaultTarget,
    targets: availableTargets,
    sparklineMinutes: UI_SPARKLINE_MINUTES,
    sseRetryMs: UI_SSE_RETRY_MS,
    eventsDedupMs: UI_EVENTS_DEDUP_MS,
    eventsCooldownMs: UI_EVENTS_COOLDOWN_MS,
    tracerouteMaxAgeMin: UI_TRACEROUTE_MAX_AGE_MIN,
    uiEwmaAlpha: config?.ui?.ewmaAlpha,
    thresholds: {
      p95: deriveAlertThreshold(config?.alerts?.rttMs, THRESH_P95_WARN_MS, THRESH_P95_CRIT_MS),
      loss: deriveAlertThreshold(config?.alerts?.lossPct, THRESH_LOSS_WARN_PCT, THRESH_LOSS_CRIT_PCT),
      dns: deriveAlertThreshold(config?.alerts?.dnsMs, THRESH_DNS_WARN_MS, THRESH_DNS_CRIT_MS),
      ttfb: buildThresholdPair(THRESH_TTFB_WARN_MS, THRESH_TTFB_CRIT_MS),
    },
  });

  const { handler, liveMetrics } = createRequestHandler(db, appConfig, {
    live: {
      pushIntervalMs: config?.liveMetrics?.pushIntervalMs,
      useWindows: config?.liveMetrics?.useWindows,
      pingTargets: config?.ping?.targets,
      staleMs: config?.liveMetrics?.staleMs,
    },
    availableTargets,
    features: config?.features,
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
            logger.error("web", "Failed to stop live metrics", error);
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

      let actualPort = listenPort;
      let actualHost = listenHost;
      const address = server.address();
      if (address && typeof address === "object") {
        if (typeof address.port === "number") {
          actualPort = address.port;
        }
        if (typeof address.address === "string" && address.address) {
          actualHost = address.address;
        }
      } else if (typeof address === "string" && address) {
        actualHost = address;
      }

      finishResolve({
        close,
        server,
        port: actualPort,
        host: actualHost,
        requestedPort,
        portConflict,
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
            logger.error("web", "Failed to stop live metrics during abort", error);
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
        logger.error("web", "Failed to stop live metrics after close", error);
      }
    });
  });
}
