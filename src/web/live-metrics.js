import { EventEmitter } from "events";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOWS = [
  { key: "win1m", duration: MINUTE_MS },
  { key: "win5m", duration: 5 * MINUTE_MS },
  { key: "win1h", duration: HOUR_MS },
];

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

function computePingWindowsFromAggregates(rows, cutoffTs, useWindows) {
  if (!useWindows) {
    return [];
  }
  const cutoffMinute = Math.floor(cutoffTs / MINUTE_MS) * MINUTE_MS;
  return rows.filter((row) => Number(row.ts_min) >= cutoffMinute);
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
    loss_pct: null,
    samples: 0,
  };

  const latencies = successEntries
    .filter((entry) => entry.ts >= cutoff)
    .map((entry) => entry.rtt)
    .filter((value) => Number.isFinite(value));
  result.p95_ms = computePercentile(latencies, 0.95);

  if (useWindows && aggregateEntries.length > 0) {
    const relevant = computePingWindowsFromAggregates(aggregateEntries, cutoff, true);
    if (relevant.length === 0) {
      // Fallback to raw data if the aggregated view has not caught up yet.
      useWindows = false;
    } else {
      let sent = 0;
      let received = 0;
      let latencySum = 0;
      let latencyCount = 0;

      for (const entry of relevant) {
        const sentCount = Number(entry.sent);
        const receivedCount = Number(entry.received);
        if (Number.isFinite(sentCount)) {
          sent += sentCount;
        }
        if (Number.isFinite(receivedCount)) {
          received += receivedCount;
        }
        const avgValue = normalizeNumber(entry.avg_ms);
        if (avgValue !== null && Number.isFinite(receivedCount) && receivedCount > 0) {
          latencySum += avgValue * receivedCount;
          latencyCount += receivedCount;
        }
      }

      result.samples = sent;
      if (latencyCount > 0) {
        result.avg_ms = latencySum / latencyCount;
      }
      if (sent > 0) {
        const effectiveReceived = Number.isFinite(received) ? received : 0;
        result.loss_pct = ((sent - effectiveReceived) / sent) * 100;
      }

      if (result.samples === 0) {
        result.samples = 0;
        result.loss_pct = null;
      }

      return result;
    }
  }

  const relevantRaw = rawEntries.filter((entry) => entry.ts >= cutoff);
  const samples = relevantRaw.length;
  result.samples = samples;
  if (samples === 0) {
    result.loss_pct = null;
    result.avg_ms = null;
    return result;
  }

  const successCount = relevantRaw.reduce((count, entry) => count + (entry.success ? 1 : 0), 0);
  if (successCount > 0) {
    const successLatencies = relevantRaw
      .filter((entry) => entry.success && Number.isFinite(entry.rtt))
      .map((entry) => entry.rtt);
    result.avg_ms = average(successLatencies);
  }
  result.loss_pct = ((samples - successCount) / samples) * 100;
  if (!Number.isFinite(result.loss_pct)) {
    result.loss_pct = null;
  }
  if (!Number.isFinite(result.avg_ms ?? NaN)) {
    result.avg_ms = null;
  }

  return result;
}

function computePingMetrics({
  now,
  configTargets,
  useWindows,
  lastSampleStmt,
  recentStmt,
  successStmt,
  windowStmt,
}) {
  const since = now - HOUR_MS;
  const rawRows = recentStmt ? recentStmt.all(since) : [];
  const successRows = successStmt ? successStmt.all(since) : [];
  const windowRows = useWindows && windowStmt ? windowStmt.all(Math.floor(since / MINUTE_MS) * MINUTE_MS) : [];

  const rawByTarget = groupRowsByTarget(rawRows, (row) => row.target);
  const successByTarget = groupRowsByTarget(successRows, (row) => row.target);
  const windowByTarget = groupRowsByTarget(windowRows, (row) => row.target);

  const targets = extractPingTargets({
    configTargets,
    rawTargets: rawByTarget.keys(),
    windowTargets: windowByTarget.keys(),
  });

  const payload = {};
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
    const aggregateEntries = windowByTarget.get(target) || [];

    const windowsPayload = {};
    for (const window of WINDOWS) {
      windowsPayload[window.key] = computePingWindowMetrics({
        now,
        duration: window.duration,
        rawEntries,
        successEntries,
        aggregateEntries,
        useWindows,
      });
    }

    payload[target] = {
      lastSample,
      ...windowsPayload,
    };
  }

  return payload;
}

function computeDnsMetrics(rows, now) {
  const successes = rows.filter(
    (row) => Number(row.success) === 1 && Number.isFinite(Number(row.lookup_ms))
  );
  const last = successes.length > 0 ? successes[successes.length - 1] : null;
  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;
  const cutoff1h = now - HOUR_MS;

  const collectValues = (cutoff) =>
    successes
      .filter((row) => Number(row.ts) >= cutoff)
      .map((row) => Number(row.lookup_ms))
      .filter((value) => Number.isFinite(value));

  const win1mValues = collectValues(cutoff1m);
  const win5mValues = collectValues(cutoff5m);
  const win1hValues = collectValues(cutoff1h);

  return {
    aggregate: {
      last_ms: last ? Number(last.lookup_ms) : null,
      win1m_avg_ms: average(win1mValues),
      win5m_avg_ms: average(win5mValues),
      win1h_avg_ms: average(win1hValues),
      samples: win1hValues.length,
    },
  };
}

function computeHttpMetrics(rows, now) {
  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;
  const cutoff1h = now - HOUR_MS;

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
    const values1h = successes
      .filter((row) => Number(row.ts) >= cutoff1h)
      .map((row) => Number(row[key]))
      .filter((value) => Number.isFinite(value));

    return {
      last_ms: last ? Number(last[key]) : null,
      win1m_avg_ms: average(values1m),
      win5m_avg_ms: average(values5m),
      win1h_avg_ms: average(values1h),
      samples: values1h.length,
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
    this.clients = new Set();
    this.timer = null;

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
      pingWindowRecent: this.db.prepare(
        "SELECT ts_min, target, sent, received, loss_pct, avg_ms FROM ping_window_1m WHERE ts_min >= ? ORDER BY ts_min ASC"
      ),
      dnsRecent: this.db.prepare(
        "SELECT ts, lookup_ms, success FROM dns_sample WHERE ts >= ? ORDER BY ts ASC"
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
      dns: { aggregate: { last_ms: null, win1m_avg_ms: null, win5m_avg_ms: null, win1h_avg_ms: null, samples: 0 } },
      http: {
        aggregate: {
          ttfb: { last_ms: null, win1m_avg_ms: null, win5m_avg_ms: null, win1h_avg_ms: null, samples: 0 },
          total: { last_ms: null, win1m_avg_ms: null, win5m_avg_ms: null, win1h_avg_ms: null, samples: 0 },
        },
      },
    };
  }

  buildPayload() {
    const now = Date.now();
    const ping = computePingMetrics({
      now,
      configTargets: this.pingTargets,
      useWindows: this.useWindows,
      lastSampleStmt: this.statements.pingLastSample,
      recentStmt: this.statements.pingRecent,
      successStmt: this.statements.pingSuccessRecent,
      windowStmt: this.statements.pingWindowRecent,
    });

    const dnsRows = this.statements.dnsRecent ? this.statements.dnsRecent.all(now - HOUR_MS) : [];
    const dns = computeDnsMetrics(dnsRows, now);

    const httpRows = this.statements.httpRecent ? this.statements.httpRecent.all(now - HOUR_MS) : [];
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
