import { EventEmitter } from "events";
import { getRuntimeStateSnapshot as getPingRuntimeState } from "../collectors/ping.js";
import {
  getTargetSnapshot as getRealtimeWindowSnapshot,
  getAllTargets as getRealtimeWindowTargets,
  getWindowDefinitions as getRealtimeWindowDefinitions,
  isEnabled as realtimeWindowsEnabled,
} from "../runtime/windows.js";
import * as logger from "../utils/logger.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

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

function extractPingTargets({ configTargets, runtimeTargets, windowTargets }) {
  const targets = new Set();
  if (Array.isArray(configTargets)) {
    for (const target of configTargets) {
      const normalized = String(target ?? "").trim();
      if (normalized) {
        targets.add(normalized);
      }
    }
  }
  for (const target of runtimeTargets ?? []) {
    if (target) {
      targets.add(String(target));
    }
  }
  for (const target of windowTargets ?? []) {
    if (target) {
      targets.add(target);
    }
  }
  return Array.from(targets).sort();
}

function computePingMetrics({
function buildWindowEntries(windowDefs, snapshot) {
  const entries = {};
  for (const def of windowDefs) {
    const windowMetrics = snapshot?.windows?.[def.id] ?? null;
    const count = Number.isFinite(windowMetrics?.count)
      ? Math.max(0, Number(windowMetrics.count))
      : 0;
    const loss = clampPercentage(windowMetrics?.loss_pct);
    const availability = clampPercentage(
      windowMetrics?.disponibilidade_pct ?? windowMetrics?.availability_pct ?? (loss == null ? null : 100 - loss)
    );

    entries[def.id] = {
      count,
      p50_ms: normalizeNumber(windowMetrics?.p50_ms),
      p95_ms: normalizeNumber(windowMetrics?.p95_ms),
      avg_ms: normalizeNumber(windowMetrics?.avg_ms),
      loss_pct: loss,
      disponibilidade_pct: availability,
      availability_pct: availability,
      status: count > 0 ? "ok" : "insufficient",
    };
  }
  return entries;
}

function computePingMetrics({ now, configTargets, runtimeState, staleThresholdMs, windowDefs }) {
  const windowEnabled = realtimeWindowsEnabled();
  const windowTargets = windowEnabled ? getRealtimeWindowTargets() : [];
  const runtimeStateMap = runtimeState && typeof runtimeState === "object" ? runtimeState : {};
  const runtimeTargets = Object.keys(runtimeStateMap);
  const targets = extractPingTargets({
    configTargets,
    runtimeTargets,
    windowTargets,
  });

  const payload = {};
  const staleLimit = Number.isFinite(staleThresholdMs) ? Math.max(0, staleThresholdMs) : 10000;

  for (const target of targets) {
    const snapshot = windowEnabled
      ? getRealtimeWindowSnapshot(target, { now })
      : { windows: {}, recent: [], latestTs: null };

    const recent = Array.isArray(snapshot?.recent)
      ? snapshot.recent
          .map((entry) => {
            const ts = Number(entry?.ts);
            if (!Number.isFinite(ts)) {
              return null;
            }
            const success = Boolean(entry?.success);
            const rttValue = Number(entry?.rtt_ms);
            return {
              ts,
              success,
              rtt_ms: success && Number.isFinite(rttValue) ? rttValue : null,
            };
          })
          .filter(Boolean)
      : [];

    const lastEntry = recent.length > 0 ? recent[recent.length - 1] : null;
    const lastSample = lastEntry
      ? {
          ts: lastEntry.ts,
          up: lastEntry.success ? 1 : 0,
          rtt_ms: lastEntry.success ? lastEntry.rtt_ms : null,
        }
      : null;

    const runtimeInfo = runtimeStateMap[target] ?? null;
    const runtimeTs = Number.isFinite(runtimeInfo?.lastSampleTs)
      ? Number(runtimeInfo.lastSampleTs)
      : null;
    const snapshotTs = Number.isFinite(snapshot?.latestTs) ? Number(snapshot.latestTs) : null;
    const resolvedTsCandidates = [runtimeTs, snapshotTs].filter((value) => Number.isFinite(value));
    const resolvedTs = resolvedTsCandidates.length > 0 ? Math.max(...resolvedTsCandidates) : null;
    const ageMs = resolvedTs != null ? Math.max(0, now - resolvedTs) : null;
    const fresh = ageMs != null ? ageMs <= staleLimit : false;

    const windowsPayload = buildWindowEntries(windowDefs, snapshot);

    const entry = {
      schema: "1.1.0",
      target,
      windows: windowsPayload,
      recent,
      lastSample,
      fresh,
      age_ms: ageMs,
      mode: typeof runtimeInfo?.mode === "string" && runtimeInfo.mode ? runtimeInfo.mode : null,
    };

    if (runtimeInfo) {
      entry.state = {
        consecutiveFailures: Number.isFinite(runtimeInfo.consecutiveFailures)
          ? Number(runtimeInfo.consecutiveFailures)
          : 0,
        consecutiveSuccesses: Number.isFinite(runtimeInfo.consecutiveSuccesses)
          ? Number(runtimeInfo.consecutiveSuccesses)
          : 0,
      };
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
    this.pingTargets = Array.isArray(this.config.pingTargets) ? this.config.pingTargets : [];
    this.staleThresholdMs =
      Number.isFinite(this.config.staleMs) && this.config.staleMs >= 0
        ? Number(this.config.staleMs)
        : 10000;
    this.clients = new Set();
    this.timer = null;
    this.runtimeStateProvider = getPingRuntimeState;

    this.statements = this.prepareStatements();
    this.windowDefinitions = getRealtimeWindowDefinitions();

    const windowSummary = realtimeWindowsEnabled()
      ? this.windowDefinitions.map((def) => def.id).join("/") || "none"
      : "disabled";
    logger.info("live", `push every ${this.intervalMs}ms, windows: ${windowSummary}`);
  }

  prepareStatements() {
    if (!this.db || typeof this.db.prepare !== "function") {
      return {};
    }
    return {
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
      runtimeState,
      staleThresholdMs: this.staleThresholdMs,
      windowDefs: this.windowDefinitions,
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
