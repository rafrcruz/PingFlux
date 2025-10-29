import { openDb, migrate } from "../storage/db.js";
import { getConfig } from "../config/index.js";

const MINUTE_MS = 60 * 1000;
let migrationsEnsured = false;

const WINDOW_CONFIGS = Object.freeze([
  { table: "ping_window_1m", minutes: 1 },
  { table: "ping_window_5m", minutes: 5 },
  { table: "ping_window_15m", minutes: 15 },
  { table: "ping_window_60m", minutes: 60 },
]);

function ensureDbReady() {
  if (!migrationsEnsured) {
    migrate();
    migrationsEnsured = true;
  }
}

function normalizeEpochMs(value, name) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid ${name} epoch milliseconds: ${value}`);
  }
  return Math.floor(num);
}

function floorToMinute(ts) {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

function computePercentile(sortedValues, percentile) {
  if (!sortedValues.length) {
    return null;
  }

  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function computeStandardDeviation(values) {
  if (!values.length) {
    return null;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildUpsertStatement(db, table) {
  const knownTable = WINDOW_CONFIGS.find((config) => config.table === table);
  if (!knownTable) {
    throw new Error(`Unsupported aggregation table: ${table}`);
  }
  return db.prepare(`
    INSERT INTO ${table} (
      ts_min,
      target,
      sent,
      received,
      loss_pct,
      avg_ms,
      p50_ms,
      p95_ms,
      stdev_ms,
      availability_pct,
      status
    ) VALUES (
      @ts_min,
      @target,
      @sent,
      @received,
      @loss_pct,
      @avg_ms,
      @p50_ms,
      @p95_ms,
      @stdev_ms,
      @availability_pct,
      @status
    )
    ON CONFLICT(ts_min, target) DO UPDATE SET
      sent = excluded.sent,
      received = excluded.received,
      loss_pct = excluded.loss_pct,
      avg_ms = excluded.avg_ms,
      p50_ms = excluded.p50_ms,
      p95_ms = excluded.p95_ms,
      stdev_ms = excluded.stdev_ms,
      availability_pct = excluded.availability_pct,
      status = excluded.status
  `);
}

function buildQueryStatement(db) {
  return db.prepare(`
    SELECT ts, target, rtt_ms, success
    FROM ping_sample
    WHERE ts BETWEEN ? AND ?
    ORDER BY ts
  `);
}

function buildBucketsByTarget(rows) {
  const map = new Map();
  for (const row of rows) {
    const ts = Number(row.ts);
    const target = typeof row.target === "string" ? row.target.trim() : "";
    if (!Number.isFinite(ts) || !target) {
      continue;
    }

    const tsMin = floorToMinute(ts);
    let targetBuckets = map.get(target);
    if (!targetBuckets) {
      targetBuckets = new Map();
      map.set(target, targetBuckets);
    }

    const key = tsMin;
    let bucket = targetBuckets.get(key);
    if (!bucket) {
      bucket = {
        ts_min: tsMin,
        target,
        sent: 0,
        received: 0,
        latencies: [],
      };
      targetBuckets.set(key, bucket);
    }

    bucket.sent += 1;
    if (Number(row.success) === 1) {
      bucket.received += 1;
      const rtt = Number(row.rtt_ms);
      if (Number.isFinite(rtt) && rtt > 0) {
        bucket.latencies.push(rtt);
      }
    }
  }

  const sortedByTarget = new Map();
  for (const [target, bucketMap] of map.entries()) {
    const list = Array.from(bucketMap.values()).sort((a, b) => a.ts_min - b.ts_min);
    sortedByTarget.set(target, list);
  }

  return sortedByTarget;
}

function clampPercentage(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

// Severity ordering helper used while aggregating each window batch.
// Executed multiple times per aggregation cycle to keep the hottest status.
const STATUS_RANK = Object.freeze({
  insufficient: -1,
  ok: 0,
  warn: 1,
  critical: 2,
});

// Normalizes a single alert value into warn/critical thresholds.
// Runs for every aggregation pass to keep configuration-driven limits in sync.
function buildThresholdPair(value) {
  const crit = Number(value);
  if (!Number.isFinite(crit) || crit <= 0) {
    return null;
  }
  const warn = crit * 0.75;
  return {
    warn,
    crit,
  };
}

// Translates alert settings into latency/loss threshold pairs per aggregation run.
function buildStatusThresholds(alertsConfig) {
  const alerts = alertsConfig && typeof alertsConfig === "object" ? alertsConfig : {};
  return {
    latency: buildThresholdPair(alerts.rttMs),
    loss: buildThresholdPair(alerts.lossPct),
  };
}

// Chooses the highest severity between two status labels during aggregation loops.
function compareStatus(current, candidate) {
  const currentRank = STATUS_RANK[current] ?? STATUS_RANK.ok;
  const candidateRank = STATUS_RANK[candidate] ?? STATUS_RANK.ok;
  return candidateRank > currentRank ? candidate : current;
}

// Applies warn/critical thresholds to a metric value for each aggregated window.
function determineStatusFromThreshold(value, pair, { higherIsBad = true } = {}) {
  if (!pair || value == null || !Number.isFinite(value)) {
    return "ok";
  }
  const warn = Number(pair.warn);
  const crit = Number(pair.crit);
  if (higherIsBad) {
    if (Number.isFinite(crit) && value >= crit) {
      return "critical";
    }
    if (Number.isFinite(warn) && value >= warn) {
      return "warn";
    }
    return "ok";
  }
  if (Number.isFinite(crit) && value <= crit) {
    return "critical";
  }
  if (Number.isFinite(warn) && value <= warn) {
    return "warn";
  }
  return "ok";
}

function createWindowEntry({
  ts_min,
  target,
  sent,
  received,
  latencies,
  minSamples,
  thresholds,
}) {
  const entry = {
    ts_min,
    target,
    sent,
    received,
    loss_pct: null,
    avg_ms: null,
    p50_ms: null,
    p95_ms: null,
    stdev_ms: null,
    availability_pct: null,
    status: "insufficient",
  };

  if (!Number.isFinite(sent) || sent <= 0) {
    return entry;
  }

  if (sent < minSamples) {
    return entry;
  }

  const safeReceived = Number.isFinite(received) ? received : 0;
  const failures = Math.max(0, sent - safeReceived);
  const loss = (failures / sent) * 100;
  const safeLatencies = Array.isArray(latencies)
    ? latencies.filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const sortedLatencies = safeLatencies.slice().sort((a, b) => a - b);

  entry.status = "ok";
  entry.loss_pct = clampPercentage(loss);
  entry.availability_pct = entry.loss_pct == null ? null : clampPercentage(100 - entry.loss_pct);

  if (sortedLatencies.length > 0) {
    const sum = sortedLatencies.reduce((acc, value) => acc + value, 0);
    entry.avg_ms = sum / sortedLatencies.length;
    entry.p50_ms = computePercentile(sortedLatencies, 0.5);
    entry.p95_ms = computePercentile(sortedLatencies, 0.95);
    entry.stdev_ms = computeStandardDeviation(sortedLatencies);
  }

  if (thresholds && typeof thresholds === "object") {
    let status = entry.status;
    status = compareStatus(status, determineStatusFromThreshold(entry.loss_pct, thresholds.loss));
    status = compareStatus(status, determineStatusFromThreshold(entry.avg_ms, thresholds.latency));
    status = compareStatus(status, determineStatusFromThreshold(entry.p95_ms, thresholds.latency));
    entry.status = status;
  }

  return entry;
}

function computeWindowEntriesForTarget(buckets, minutes, minSamples, thresholds) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return [];
  }

  const lookbackMs = (minutes - 1) * MINUTE_MS;
  const windowEntries = [];
  const queue = [];

  for (const bucket of buckets) {
    queue.push(bucket);
    const cutoffTs = bucket.ts_min - lookbackMs;
    while (queue.length > 0 && queue[0].ts_min < cutoffTs) {
      queue.shift();
    }

    let sent = 0;
    let received = 0;
    const latencies = [];
    for (const item of queue) {
      sent += Number.isFinite(item.sent) ? item.sent : 0;
      received += Number.isFinite(item.received) ? item.received : 0;
      if (Array.isArray(item.latencies) && item.latencies.length > 0) {
        latencies.push(...item.latencies);
      }
    }

    windowEntries.push(
      createWindowEntry({
        ts_min: bucket.ts_min,
        target: bucket.target,
        sent,
        received,
        latencies,
        minSamples,
        thresholds,
      })
    );
  }

  return windowEntries;
}

function computeMinSamplesByTable(pingIntervalMs) {
  const sanitizedInterval = Number.isFinite(pingIntervalMs) && pingIntervalMs > 0 ? pingIntervalMs : MINUTE_MS;
  const map = new Map();
  for (const config of WINDOW_CONFIGS) {
    const windowMs = config.minutes * MINUTE_MS;
    const expected = Math.ceil(windowMs / sanitizedInterval);
    map.set(config.table, Math.max(1, expected));
  }
  return map;
}

function aggregateBucketsByWindow(bucketsByTarget, minSamplesByTable, thresholds) {
  const results = new Map(WINDOW_CONFIGS.map((config) => [config.table, []]));

  for (const [target, buckets] of bucketsByTarget.entries()) {
    for (const config of WINDOW_CONFIGS) {
      const minSamples = minSamplesByTable.get(config.table) ?? 1;
      const entries = computeWindowEntriesForTarget(
        buckets,
        config.minutes,
        minSamples,
        thresholds
      );
      if (entries.length > 0) {
        const list = results.get(config.table);
        list.push(...entries);
      }
    }
  }

  return results;
}

export function aggregateRange(fromEpochMs, toEpochMs) {
  const from = normalizeEpochMs(fromEpochMs, "from");
  const to = normalizeEpochMs(toEpochMs, "to");

  if (to < from) {
    throw new Error(`Invalid range: to (${to}) is before from (${from})`);
  }

  ensureDbReady();
  const db = openDb();
  const query = buildQueryStatement(db);
  const rows = query.all(from, to);

  if (!rows.length) {
    return 0;
  }

  const bucketsByTarget = buildBucketsByTarget(rows);
  if (!bucketsByTarget.size) {
    return 0;
  }

  const config = getConfig();
  const pingIntervalMs = Number(config?.ping?.intervalMs);
  const thresholds = buildStatusThresholds(config?.alerts);
  const minSamplesByTable = computeMinSamplesByTable(pingIntervalMs);
  const aggregated = aggregateBucketsByWindow(bucketsByTarget, minSamplesByTable, thresholds);

  const transactions = new Map();
  let processed1m = 0;

  for (const [table, entries] of aggregated.entries()) {
    if (!entries || entries.length === 0) {
      continue;
    }

    let transaction = transactions.get(table);
    if (!transaction) {
      const stmt = buildUpsertStatement(db, table);
      transaction = db.transaction((list) => {
        for (const entry of list) {
          stmt.run(entry);
        }
      });
      transactions.set(table, transaction);
    }

    transaction(entries);
    if (table === "ping_window_1m") {
      processed1m += entries.length;
    }
  }

  return processed1m;
}

export function aggregateSince(sinceEpochMs) {
  const since = normalizeEpochMs(sinceEpochMs, "since");
  const now = Date.now();

  if (now < since) {
    throw new Error(`Invalid range: now (${now}) is before since (${since})`);
  }

  return aggregateRange(since, now);
}
