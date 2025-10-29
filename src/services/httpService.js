import * as httpRepo from "../data/httpRepo.js";
import { createLogger } from "../runtime/logger.js";

const log = createLogger("http");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function average(values) {
  if (!values || values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function collectMetric(rows, key, now) {
  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;
  const cutoff1h = now - HOUR_MS;
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
}

export function recordSamples(samples) {
  return httpRepo.insertSamples(samples);
}

export function getSamplesInRange(params) {
  return httpRepo.selectSamplesBetween(params);
}

export function buildLiveHttpMetrics({ now = Date.now() } = {}) {
  const since = now - HOUR_MS;
  const rows = httpRepo.selectSamplesSince({ sinceMs: since });
  return {
    aggregate: {
      ttfb: collectMetric(rows, "ttfb_ms", now),
      total: collectMetric(rows, "total_ms", now),
    },
  };
}

export function getHttpCounters() {
  try {
    return httpRepo.countSamplesByUrl();
  } catch (error) {
    log.error("Failed to count HTTP samples", error);
    return [];
  }
}
