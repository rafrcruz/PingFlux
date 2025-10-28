import { openDb, migrate } from "../storage/db.js";

const MINUTE_MS = 60 * 1000;
let migrationsEnsured = false;

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
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildUpsertStatement(db) {
  return db.prepare(`
    INSERT INTO ping_window_1m (
      ts_min,
      target,
      sent,
      received,
      loss_pct,
      p50_ms,
      p95_ms,
      stdev_ms
    ) VALUES (
      @ts_min,
      @target,
      @sent,
      @received,
      @loss_pct,
      @p50_ms,
      @p95_ms,
      @stdev_ms
    )
    ON CONFLICT(ts_min, target) DO UPDATE SET
      sent = excluded.sent,
      received = excluded.received,
      loss_pct = excluded.loss_pct,
      p50_ms = excluded.p50_ms,
      p95_ms = excluded.p95_ms,
      stdev_ms = excluded.stdev_ms
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

function buildBuckets(rows) {
  const buckets = new Map();

  for (const row of rows) {
    const ts = Number(row.ts);
    const target = row.target;

    if (!Number.isFinite(ts) || !target) {
      continue;
    }

    const tsMin = floorToMinute(ts);
    const key = `${tsMin}__${target}`;
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = {
        ts_min: tsMin,
        target,
        sent: 0,
        received: 0,
        latencies: [],
      };
      buckets.set(key, bucket);
    }

    bucket.sent += 1;
    if (row.success) {
      bucket.received += 1;
      const rtt = Number(row.rtt_ms);
      if (Number.isFinite(rtt)) {
        bucket.latencies.push(rtt);
      }
    }
  }

  return buckets;
}

function finalizeBuckets(buckets) {
  const finalized = [];

  for (const bucket of buckets.values()) {
    const lossPct =
      bucket.sent > 0 ? ((bucket.sent - bucket.received) / bucket.sent) * 100 : 0;
    const sortedLatencies = bucket.latencies.slice().sort((a, b) => a - b);
    const p50 = computePercentile(sortedLatencies, 0.5);
    const p95 = computePercentile(sortedLatencies, 0.95);
    const stdev = computeStandardDeviation(sortedLatencies);

    finalized.push({
      ts_min: bucket.ts_min,
      target: bucket.target,
      sent: bucket.sent,
      received: bucket.received,
      loss_pct: lossPct,
      p50_ms: p50,
      p95_ms: p95,
      stdev_ms: stdev,
    });
  }

  return finalized;
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

  const buckets = buildBuckets(rows);
  if (!buckets.size) {
    return 0;
  }

  const finalized = finalizeBuckets(buckets);
  if (!finalized.length) {
    return 0;
  }

  const upsert = buildUpsertStatement(db);
  const runUpserts = db.transaction((entries) => {
    for (const entry of entries) {
      upsert.run(entry);
    }
  });

  runUpserts(finalized);

  return finalized.length;
}

export function aggregateSince(sinceEpochMs) {
  const since = normalizeEpochMs(sinceEpochMs, "since");
  const now = Date.now();

  if (now < since) {
    throw new Error(`Invalid range: now (${now}) is before since (${since})`);
  }

  return aggregateRange(since, now);
}
