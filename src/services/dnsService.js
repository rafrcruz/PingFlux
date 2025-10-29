import * as dnsRepo from "../data/dnsRepo.js";
import { createLogger } from "../runtime/logger.js";

const log = createLogger("dns");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function average(values) {
  if (!values || values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

export function recordSamples(samples) {
  return dnsRepo.insertSamples(samples);
}

export function getSamplesInRange(params) {
  return dnsRepo.selectSamplesBetween(params);
}

export function buildLiveDnsMetrics({ now = Date.now() } = {}) {
  const since = now - HOUR_MS;
  const rows = dnsRepo.selectSamplesSince({ sinceMs: since });
  const successes = rows.filter(
    (row) => Number(row.success) === 1 && Number.isFinite(Number(row.lookup_ms))
  );
  const last = successes.length > 0 ? successes[successes.length - 1] : null;
  const cutoff1m = now - MINUTE_MS;
  const cutoff5m = now - 5 * MINUTE_MS;

  const collectValues = (cutoff) =>
    successes
      .filter((row) => Number(row.ts) >= cutoff)
      .map((row) => Number(row.lookup_ms))
      .filter((value) => Number.isFinite(value));

  const win1mValues = collectValues(cutoff1m);
  const win5mValues = collectValues(cutoff5m);
  const win1hValues = collectValues(since);

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

export function getDnsCounters() {
  try {
    return dnsRepo.countSamplesByHostname();
  } catch (error) {
    log.error("Failed to count DNS samples", error);
    return [];
  }
}
