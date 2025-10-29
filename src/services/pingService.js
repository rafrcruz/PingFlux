import * as pingRepo from "../data/pingRepo.js";
import { createLogger } from "../runtime/logger.js";
import { getConfig } from "../config/index.js";

const log = createLogger("ping");

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
  for (const target of configTargets ?? []) {
    const normalized = String(target ?? "").trim();
    if (normalized) {
      targets.add(normalized);
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
    loss_pct: null,
    samples: 0,
  };

  const latencies = successEntries
    .filter((entry) => entry.ts >= cutoff)
    .map((entry) => entry.rtt)
    .filter((value) => Number.isFinite(value));
  result.p95_ms = computePercentile(latencies, 0.95);

  if (useWindows && aggregateEntries.length > 0) {
    const cutoffMinute = Math.floor(cutoff / MINUTE_MS) * MINUTE_MS;
    const relevant = aggregateEntries.filter((row) => Number(row.ts_min) >= cutoffMinute);
    if (relevant.length > 0) {
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
      if (!Number.isFinite(result.loss_pct ?? NaN)) {
        result.loss_pct = null;
      }
      if (!Number.isFinite(result.avg_ms ?? NaN)) {
        result.avg_ms = null;
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

export function recordSamples(samples) {
  return pingRepo.insertSamples(samples);
}

export function getSamplesInRange(params) {
  return pingRepo.selectSamplesBetween(params);
}

export function getWindowAggregates(params) {
  return pingRepo.selectWindowsBetween(params);
}

export function upsertWindowEntries(entries) {
  return pingRepo.upsertWindows(entries);
}

export function buildLivePingMetrics({ now = Date.now(), useWindows = true } = {}) {
  const config = getConfig();
  const configTargets = Array.isArray(config?.pingTargets) ? config.pingTargets : [];
  const since = now - HOUR_MS;

  const rawRows = pingRepo.selectSamplesSince({ sinceMs: since });
  const successRows = pingRepo.selectSamplesSince({ sinceMs: since, successOnly: true });
  const windowRows = useWindows
    ? pingRepo.selectWindowsSince({ sinceMs: Math.floor(since / MINUTE_MS) * MINUTE_MS })
    : [];

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
    try {
      const lastRow = pingRepo.selectLatestSampleByTarget(target);
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
    } catch (error) {
      log.error("Failed to compute metrics for target", target, error);
    }
  }

  return payload;
}

export function getPingCounters() {
  return pingRepo.countSamplesByTarget();
}
