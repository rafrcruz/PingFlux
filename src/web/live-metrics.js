import { EventEmitter } from "events";
import { getRuntimeStateSnapshot as getPingRuntimeState } from "../collectors/ping.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOWS = [
  { key: "win1m", duration: MINUTE_MS },
  { key: "win5m", duration: 5 * MINUTE_MS },
  { key: "win15m", duration: 15 * MINUTE_MS },
  { key: "win60m", duration: HOUR_MS },
];
const WINDOW_KEY_TO_TABLE = Object.freeze({
  win1m: "ping_window_1m",
  win5m: "ping_window_5m",
  win15m: "ping_window_15m",
  win60m: "ping_window_60m",
});
const PING_WINDOW_TABLES = Object.freeze(Object.values(WINDOW_KEY_TO_TABLE));

function computePercentile(values, percentile) {
  if (!values || values.length === 0) {
    return null;
  }

  const sorted = values.slice().sort((a, b) => a - b);
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

function average(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
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

function preparePingWindowRecentStatements(db) {
  const map = new Map();
  for (const table of PING_WINDOW_TABLES) {
    map.set(
      table,
      db.prepare(
        `SELECT ts_min, target, sent, received, loss_pct, avg_ms, p50_ms, p95_ms, stdev_ms, availability_pct, status FROM ${table} WHERE ts_min >= ? ORDER BY ts_min ASC`
      )
    );
  }
  return map;
}

function getWindowStatement(map, table) {
  if (!map) {
    return null;
  }
  if (map instanceof Map) {
    return map.get(table) ?? null;
  }
  if (typeof map === "object" && map !== null) {
    return map[table] ?? null;
  }
  return null;
}

function extractPingTargets({ configTargets, rawTargets, windowTargets }) {
  const targets = new Set();
  if (Array.isArray(configTargets)) {
    for (const target of configTargets) {
      const normalized = String(target ?? "").trim();
      if (normalized) {
        targets.add(normalized);
      }
    }
  }
  for (const target of rawTargets ?? []) {
    if (target) {
      targets.add(target);
    }
  }
  for (const target of windowTargets ?? []) {
    if (target) {
      targets.add(target);
    }
  }
  return Array.from(targets).sort();
}

function groupRowsByTarget(rows, mapper) {
  const map = new Map();
  if (!Array.isArray(rows)) {
    return map;
  }
  for (const row of rows) {
    if (!row) {
      continue;
    }
    const target = mapper(row);
    if (!target) {
      continue;
    }
    let list = map.get(target);
    if (!list) {
      list = [];
      map.set(target, list);
    }
    list.push(row);
  }
  return map;
}

function computePingWindowMetrics({
  now,
  duration,
  rawEntries,
  successEntries,
  aggregateEntries,
  useWindows,
}) {
  const cutoff = now - duration;
  const result = {
    avg_ms: null,
    p95_ms: null,
    p50_ms: null,
    loss_pct: null,
    availability_pct: null,
    samples: 0,
    status: "insufficient",
  };

  if (useWindows && Array.isArray(aggregateEntries) && aggregateEntries.length > 0) {
    const latest = aggregateEntries[aggregateEntries.length - 1];
    const status =
      typeof latest?.status === "string" && latest.status.trim().length ? latest.status : "ok";
    result.status = status;
    result.samples = Number.isFinite(Number(latest?.sent)) ? Number(latest.sent) : 0;
    if (status === "ok") {
      result.avg_ms = normalizeNumber(latest?.avg_ms);
      result.p50_ms = normalizeNumber(latest?.p50_ms);
      result.p95_ms = normalizeNumber(latest?.p95_ms);
      result.loss_pct = clampPercentage(latest?.loss_pct);
      result.availability_pct = clampPercentage(
        latest?.availability_pct ?? (result.loss_pct == null ? null : 100 - result.loss_pct)
      );
    }
    return result;
  }

  const relevantRaw = rawEntries.filter((entry) => entry.ts >= cutoff);
  const samples = relevantRaw.length;
  result.samples = samples;
  if (samples === 0) {
    return result;
  }

  const successValues = relevantRaw.filter((entry) => entry.success && Number.isFinite(entry.rtt));
  const successCount = successValues.length;
  if (successCount > 0) {
    const latencies = successValues.map((entry) => entry.rtt);
    result.avg_ms = average(latencies);
    result.p50_ms = computePercentile(latencies, 0.5);
    result.p95_ms = computePercentile(latencies, 0.95);
  }

  result.loss_pct = clampPercentage(((samples - successCount) / samples) * 100);
  if (!Number.isFinite(result.avg_ms ?? NaN)) {
    result.avg_ms = null;
  }
  if (!Number.isFinite(result.p50_ms ?? NaN)) {
    result.p50_ms = null;
  }
  if (!Number.isFinite(result.p95_ms ?? NaN)) {
    result.p95_ms = null;
  }
  result.availability_pct = clampPercentage(
    result.loss_pct == null ? null : 100 - result.loss_pct
  );
  result.status = "ok";

  return result;
}

function computePingMetrics({
  now,
  configTargets,
  useWindows,
  lastSampleStmt,
  recentStmt,
  successStmt,
  windowStmts,
  runtimeState,
  staleThresholdMs,
}) {
  const since = now - HOUR_MS;
  const rawRows = recentStmt ? recentStmt.all(since) : [];
  const successRows = successStmt ? successStmt.all(since) : [];
  const windowRowsByKey = new Map();
  const aggregatedTargets = new Set();
  if (useWindows && windowStmts) {
    const cutoffMinute = Math.floor(since / MINUTE_MS) * MINUTE_MS;
    for (const window of WINDOWS) {
      const table = WINDOW_KEY_TO_TABLE[window.key];
      const stmt = getWindowStatement(windowStmts, table);
      const rows = stmt ? stmt.all(cutoffMinute) : [];
      const grouped = groupRowsByTarget(rows, (row) => row.target);
      windowRowsByKey.set(window.key, grouped);
      for (const targetKey of grouped.keys()) {
        aggregatedTargets.add(targetKey);
      }
    }
  }

  const rawByTarget = groupRowsByTarget(rawRows, (row) => row.target);
  const successByTarget = groupRowsByTarget(successRows, (row) => row.target);

  const targets = extractPingTargets({
    configTargets,
    rawTargets: rawByTarget.keys(),
    windowTargets: aggregatedTargets.values(),
  });

  const payload = {};
  const staleLimit = Number.isFinite(staleThresholdMs) ? Math.max(0, staleThresholdMs) : 10000;
  const runtimeStateMap = runtimeState && typeof runtimeState === "object" ? runtimeState : {};

  for (const target of targets) {
    const lastRow = lastSampleStmt ? lastSampleStmt.get(target) : null;
    const lastSample = {
      rtt_ms: null,
      up: 0,
      ts: null,
    };
    if (lastRow) {
      const ts = Number(lastRow.ts);
      lastSample.ts = Number.isFinite(ts) ? ts : null;
      const success = Number(lastRow.success) === 1;
      lastSample.up = success ? 1 : 0;
      const rtt = normalizeNumber(lastRow.rtt_ms);
      lastSample.rtt_ms = success ? rtt : null;
    }

    const rawEntries = (rawByTarget.get(target) || []).map((row) => ({
      ts: Number(row.ts),
      success: Number(row.success) === 1,
      rtt: normalizeNumber(row.rtt_ms),
    }));
    const successEntries = (successByTarget.get(target) || []).map((row) => ({
      ts: Number(row.ts),
      rtt: normalizeNumber(row.rtt_ms),
    }));

    const windowsPayload = {};
    for (const window of WINDOWS) {
      const aggregateGroup = windowRowsByKey.get(window.key);
      const aggregateEntries = aggregateGroup ? aggregateGroup.get(target) || [] : [];
      windowsPayload[window.key] = computePingWindowMetrics({
        now,
        duration: window.duration,
        rawEntries,
        successEntries,
        aggregateEntries,
        useWindows,
      });
    }

    const runtimeInfo = runtimeStateMap[target] ?? null;
    const runtimeLastTs = Number.isFinite(runtimeInfo?.lastSampleTs)
      ? Number(runtimeInfo.lastSampleTs)
      : null;
    const sampleTs = Number.isFinite(lastSample.ts) ? Number(lastSample.ts) : null;
    const latestTs = [runtimeLastTs, sampleTs].filter((value) => Number.isFinite(value));
    const resolvedTs = latestTs.length > 0 ? Math.max(...latestTs) : null;
    const ageMs = resolvedTs != null ? Math.max(0, now - resolvedTs) : null;
    // Freshness flag used by the UI to highlight stale data.
    const fresh = ageMs == null ? false : ageMs <= staleLimit;
    const pingMode =
      typeof runtimeInfo?.mode === "string" && runtimeInfo.mode ? runtimeInfo.mode : null;
    const runtimeCounters = runtimeInfo
      ? {
          consecutiveFailures: Number.isFinite(runtimeInfo.consecutiveFailures)
            ? Number(runtimeInfo.consecutiveFailures)
            : 0,
          consecutiveSuccesses: Number.isFinite(runtimeInfo.consecutiveSuccesses)
            ? Number(runtimeInfo.consecutiveSuccesses)
            : 0,
        }
      : null;

    const entry = {
      lastSample,
      ...windowsPayload,
      fresh,
      age_ms: ageMs,
      pingMode,
    };

    if (runtimeCounters) {
      entry.state = runtimeCounters;
    }

    payload[target] = entry;
  }

  return payload;
}

// Normalizes DNS samples for the given mode (hot/cold).
// Called on every live metrics refresh (a few times per minute).
function extractDnsEntries(rows, valueKey, successKey) {
  return rows
    .filter((row) => Number(row[successKey]) === 1 && Number.isFinite(Number(row[valueKey])))
    .map((row) => ({ ts: Number(row.ts), value: Number(row[valueKey]) }))
    .filter((entry) => Number.isFinite(entry.ts) && Number.isFinite(entry.value))
    .sort((a, b) => a.ts - b.ts);
}

// Builds rolling averages for DNS measurements within the live metrics window.
// Invoked per mode (hot/cold) each time we push an SSE payload.
function buildDnsStats(entries, now) {
  const stats = {
    last_ms: null,
    win1m_avg_ms: null,
    win5m_avg_ms: null,
    win15m_avg_ms: null,
    win60m_avg_ms: null,
    samples: 0,
  };

  if (!entries || entries.length === 0) {
    return stats;
  }

  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;
  const cutoff15m = now - 15 * MINUTE_MS;
  const cutoff60m = now - HOUR_MS;

  const collect = (cutoff) =>
    entries.filter((entry) => Number(entry.ts) >= cutoff).map((entry) => entry.value);

  const last = entries[entries.length - 1];
  stats.last_ms = Number.isFinite(last?.value) ? last.value : null;
  stats.win1m_avg_ms = average(collect(cutoff1m));
  stats.win5m_avg_ms = average(collect(cutoff5m));
  stats.win15m_avg_ms = average(collect(cutoff15m));
  stats.win60m_avg_ms = average(collect(cutoff60m));
  stats.samples = entries.length;

  return stats;
}

function computeDnsMetrics(rows, now) {
  const coldEntries = extractDnsEntries(rows, "lookup_ms_cold", "success_cold");
  const hotEntries = extractDnsEntries(rows, "lookup_ms_hot", "success_hot");
  const fallbackEntries = coldEntries.length > 0 ? coldEntries : hotEntries;

  const coldStats = buildDnsStats(coldEntries, now);
  const hotStats = buildDnsStats(hotEntries, now);
  const primaryStats = buildDnsStats(fallbackEntries, now);

  return {
    aggregate: {
      ...primaryStats,
      mode: coldEntries.length > 0 ? "cold" : "hot",
      cold: coldStats,
      hot: hotStats,
    },
  };
}

function computeHttpMetrics(rows, now) {
  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;
  const cutoff15m = now - 15 * MINUTE_MS;
  const cutoff60m = now - HOUR_MS;

  const collectMetric = (key) => {
    const successes = rows.filter(
      (row) => Number(row.success) === 1 && Number.isFinite(Number(row[key]))
    );
    const last = successes.length > 0 ? successes[successes.length - 1] : null;
    const values1m = successes
      .filter((row) => Number(row.ts) >= cutoff1m)
      .map((row) => Number(row[key]))
      .filter((value) => Number.isFinite(value));
    const values5m = successes
      .filter((row) => Number(row.ts) >= cutoff5m)
      .map((row) => Number(row[key]))
      .filter((value) => Number.isFinite(value));
    const values15m = successes
      .filter((row) => Number(row.ts) >= cutoff15m)
      .map((row) => Number(row[key]))
      .filter((value) => Number.isFinite(value));
    const values60m = successes
      .filter((row) => Number(row.ts) >= cutoff60m)
      .map((row) => Number(row[key]))
      .filter((value) => Number.isFinite(value));

    return {
      last_ms: last ? Number(last[key]) : null,
      win1m_avg_ms: average(values1m),
      win5m_avg_ms: average(values5m),
      win15m_avg_ms: average(values15m),
      win60m_avg_ms: average(values60m),
      samples: values60m.length,
    };
  };

  return {
    aggregate: {
      ttfb: collectMetric("ttfb_ms"),
      total: collectMetric("total_ms"),
    },
  };
}

class LiveMetricsBroadcaster extends EventEmitter {
  constructor({ db, config }) {
    super();
    this.db = db;
    this.config = config ?? {};
    const interval = Number(this.config.pushIntervalMs ?? 2000);
    this.intervalMs = Number.isFinite(interval) && interval > 0 ? interval : 2000;
    this.useWindows = Boolean(this.config.useWindows);
    this.pingTargets = Array.isArray(this.config.pingTargets) ? this.config.pingTargets : [];
    this.staleThresholdMs =
      Number.isFinite(this.config.staleMs) && this.config.staleMs >= 0
        ? Number(this.config.staleMs)
        : 10000;
    this.clients = new Set();
    this.timer = null;
    this.runtimeStateProvider = getPingRuntimeState;

    this.statements = this.prepareStatements();
  }

  prepareStatements() {
    if (!this.db || typeof this.db.prepare !== "function") {
      return {};
    }
    return {
      pingLastSample: this.db.prepare(
        "SELECT ts, success, rtt_ms FROM ping_sample WHERE target = ? ORDER BY ts DESC LIMIT 1"
      ),
      pingRecent: this.db.prepare(
        "SELECT ts, target, rtt_ms, success FROM ping_sample WHERE ts >= ? ORDER BY ts ASC"
      ),
      pingSuccessRecent: this.db.prepare(
        "SELECT ts, target, rtt_ms FROM ping_sample WHERE success = 1 AND ts >= ? ORDER BY ts ASC"
      ),
      pingWindowTables: preparePingWindowRecentStatements(this.db),
      dnsRecent: this.db.prepare(
        "SELECT ts, lookup_ms, lookup_ms_hot, lookup_ms_cold, success, success_hot, success_cold FROM dns_sample WHERE ts >= ? ORDER BY ts ASC"
      ),
      httpRecent: this.db.prepare(
        "SELECT ts, ttfb_ms, total_ms, success FROM http_sample WHERE ts >= ? ORDER BY ts ASC"
      ),
    };
  }

  handleRequest(req, res) {
    if (!res || typeof res.writeHead !== "function") {
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    this.addClient(req, res);
    this.pushOnce(res);
  }

  addClient(req, res) {
    this.clients.add(res);

    const remove = () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.stopTimer();
      }
    };

    req?.on?.("close", remove);
    res.on("close", remove);
    res.on("error", remove);

    if (!this.timer) {
      this.startTimer();
    }
  }

  startTimer() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.broadcast();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  pushOnce(res) {
    try {
      const payload = this.buildPayload();
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      res.write(data);
    } catch (error) {
      console.error("[live] Failed to push initial payload:", error);
      try {
        res.write(`data: ${JSON.stringify(this.buildEmptyPayload())}\n\n`);
      } catch (fallbackError) {
        console.error("[live] Failed to send fallback payload:", fallbackError);
      }
    }
  }

  broadcast() {
    if (this.clients.size === 0) {
      return;
    }

    let payload;
    try {
      payload = this.buildPayload();
    } catch (error) {
      console.error("[live] Failed to build live payload:", error);
      payload = this.buildEmptyPayload();
    }

    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(data);
      } catch (error) {
        this.clients.delete(client);
        try {
          client.end();
        } catch (endError) {
          // Ignore errors while closing the stream.
        }
      }
    }

    if (this.clients.size === 0) {
      this.stopTimer();
    }
  }

  buildEmptyPayload() {
    const now = Date.now();
    return {
      ts: now,
      ping: {},
      dns: {
        aggregate: {
          last_ms: null,
          win1m_avg_ms: null,
          win5m_avg_ms: null,
          win15m_avg_ms: null,
          win60m_avg_ms: null,
          samples: 0,
          mode: "cold",
          cold: {
            last_ms: null,
            win1m_avg_ms: null,
            win5m_avg_ms: null,
            win15m_avg_ms: null,
            win60m_avg_ms: null,
            samples: 0,
          },
          hot: {
            last_ms: null,
            win1m_avg_ms: null,
            win5m_avg_ms: null,
            win15m_avg_ms: null,
            win60m_avg_ms: null,
            samples: 0,
          },
        },
      },
      http: {
        aggregate: {
          ttfb: {
            last_ms: null,
            win1m_avg_ms: null,
            win5m_avg_ms: null,
            win15m_avg_ms: null,
            win60m_avg_ms: null,
            samples: 0,
          },
          total: {
            last_ms: null,
            win1m_avg_ms: null,
            win5m_avg_ms: null,
            win15m_avg_ms: null,
            win60m_avg_ms: null,
            samples: 0,
          },
        },
      },
    };
  }

  buildPayload() {
    const now = Date.now();
    const runtimeState = this.runtimeStateProvider ? this.runtimeStateProvider() : {};
    const ping = computePingMetrics({
      now,
      configTargets: this.pingTargets,
      useWindows: this.useWindows,
      lastSampleStmt: this.statements.pingLastSample,
      recentStmt: this.statements.pingRecent,
      successStmt: this.statements.pingSuccessRecent,
      windowStmts: this.statements.pingWindowTables,
      runtimeState,
      staleThresholdMs: this.staleThresholdMs,
    });

    const dnsRows = this.statements.dnsRecent ? this.statements.dnsRecent.all(now - HOUR_MS) : [];
    const dns = computeDnsMetrics(dnsRows, now);

    const httpRows = this.statements.httpRecent
      ? this.statements.httpRecent.all(now - HOUR_MS)
      : [];
    const http = computeHttpMetrics(httpRows, now);

    return {
      ts: now,
      ping,
      dns,
      http,
    };
  }

  close() {
    this.stopTimer();
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch (error) {
        // Ignore errors while closing streams.
      }
    }
    this.clients.clear();
  }
}

export function createLiveMetricsBroadcaster({ db, config }) {
  if (!db) {
    return null;
  }
  return new LiveMetricsBroadcaster({ db, config });
}
