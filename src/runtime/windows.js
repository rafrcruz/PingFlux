import { getConfig } from "../config/index.js";

const BASE_WINDOWS = [
  { id: "1m", fallbackMs: 60 * 1000 },
  { id: "5m", fallbackMs: 5 * 60 * 1000 },
  { id: "15m", fallbackMs: 15 * 60 * 1000 },
  { id: "60m", fallbackMs: 60 * 60 * 1000 },
];

class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, Number.parseInt(capacity, 10) || 1);
    this.values = new Array(this.capacity);
    this.start = 0;
    this.size = 0;
  }

  push(value) {
    if (this.size < this.capacity) {
      const index = (this.start + this.size) % this.capacity;
      this.values[index] = value;
      this.size += 1;
      return;
    }

    this.values[this.start] = value;
    this.start = (this.start + 1) % this.capacity;
  }

  pruneOlderThan(cutoffTs) {
    const cutoff = Number(cutoffTs);
    if (!Number.isFinite(cutoff)) {
      return;
    }
    while (this.size > 0) {
      const entry = this.values[this.start];
      const ts = Number(entry?.ts);
      if (!Number.isFinite(ts) || ts < cutoff) {
        this.values[this.start] = undefined;
        this.start = (this.start + 1) % this.capacity;
        this.size -= 1;
      } else {
        break;
      }
    }
  }

  toArray() {
    const result = [];
    for (let i = 0; i < this.size; i += 1) {
      const index = (this.start + i) % this.capacity;
      const entry = this.values[index];
      if (entry) {
        result.push(entry);
      }
    }
    return result;
  }
}

function buildWindowConfiguration() {
  const config = getConfig();
  const runtime = config?.runtimeWindows ?? {};
  const durations = runtime?.durations ?? {};
  const enabled = runtime?.enabled !== false;

  const windows = BASE_WINDOWS.map((base) => {
    const raw = durations?.[base.id];
    const parsed = Number(raw);
    const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : base.fallbackMs;
    return { id: base.id, durationMs: ms };
  })
    .filter((window) => Number.isFinite(window.durationMs) && window.durationMs > 0)
    .sort((a, b) => a.durationMs - b.durationMs);

  const longestWindowMs = windows.reduce(
    (acc, window) => (window.durationMs > acc ? window.durationMs : acc),
    0
  );

  const pingConfig = config?.ping ?? {};
  const configuredMaxPoints = Number.isFinite(pingConfig.maxInMemoryPoints)
    ? Math.max(1, Math.floor(pingConfig.maxInMemoryPoints))
    : 600;
  const intervalMs = Number.isFinite(pingConfig.intervalMs)
    ? Math.max(1, Math.floor(pingConfig.intervalMs))
    : 1000;
  const minPointsForWindows = longestWindowMs > 0 ? Math.ceil(longestWindowMs / intervalMs) + 10 : 1;
  const maxPoints = Math.max(configuredMaxPoints, minPointsForWindows);

  return {
    enabled,
    windows,
    maxPoints,
    longestWindowMs,
  };
}

const settings = buildWindowConfiguration();
const targetBuffers = new Map();

function getOrCreateTargetState(target) {
  const key = String(target ?? "").trim();
  if (!key) {
    return null;
  }
  let state = targetBuffers.get(key);
  if (!state) {
    state = {
      buffer: new RingBuffer(settings.maxPoints),
      lastTs: null,
    };
    targetBuffers.set(key, state);
  }
  return state;
}

function sanitizeSample(sample) {
  const ts = Number(sample?.ts);
  const target = String(sample?.target ?? "").trim();
  if (!target || !Number.isFinite(ts)) {
    return null;
  }
  const success = sample?.success === true || sample?.success === 1 || sample?.success === "1";
  const rttValue = Number(sample?.rtt_ms);
  const rttMs = success && Number.isFinite(rttValue) && rttValue >= 0 ? rttValue : null;
  return { ts, target, success, rtt_ms: rttMs };
}

export function isEnabled() {
  return settings.enabled && settings.windows.length > 0;
}

export function getWindowDefinitions() {
  return settings.windows.slice();
}

export function getMaxRetentionMs() {
  return settings.longestWindowMs;
}

export function ensureTarget(target) {
  if (!isEnabled()) {
    return;
  }
  getOrCreateTargetState(target);
}

export function recordPingSample(sample) {
  if (!isEnabled()) {
    return;
  }
  const normalized = sanitizeSample(sample);
  if (!normalized) {
    return;
  }

  const state = getOrCreateTargetState(normalized.target);
  if (!state) {
    return;
  }

  state.buffer.push({
    ts: normalized.ts,
    success: normalized.success,
    rtt_ms: normalized.rtt_ms,
  });
  state.lastTs = normalized.ts;

  if (settings.longestWindowMs > 0) {
    const cutoff = normalized.ts - settings.longestWindowMs;
    state.buffer.pruneOlderThan(cutoff);
  }
}

function computePercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
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
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function computeWindowStats(entries, windowMs, now) {
  if (!windowMs || windowMs <= 0) {
    return {
      count: 0,
      p50_ms: null,
      p95_ms: null,
      avg_ms: null,
      loss_pct: null,
      disponibilidade_pct: null,
    };
  }

  const cutoff = now - windowMs;
  const windowEntries = entries.filter((entry) => Number(entry.ts) >= cutoff);
  const count = windowEntries.length;
  if (count === 0) {
    return {
      count: 0,
      p50_ms: null,
      p95_ms: null,
      avg_ms: null,
      loss_pct: null,
      disponibilidade_pct: null,
    };
  }

  const successEntries = windowEntries.filter((entry) => entry.success);
  const latencyValues = successEntries
    .map((entry) => Number(entry.rtt_ms))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const successCount = successEntries.length;
  const avgMs = latencyValues.length > 0 ? average(latencyValues) : null;
  const p50 = latencyValues.length > 0 ? computePercentile(latencyValues, 0.5) : null;
  const p95 = latencyValues.length > 0 ? computePercentile(latencyValues, 0.95) : null;

  const lossPct = ((count - successCount) / count) * 100;
  const availability = 100 - lossPct;

  return {
    count,
    p50_ms: Number.isFinite(p50) ? p50 : null,
    p95_ms: Number.isFinite(p95) ? p95 : null,
    avg_ms: Number.isFinite(avgMs) ? avgMs : null,
    loss_pct: Number.isFinite(lossPct) ? Math.max(0, Math.min(100, lossPct)) : null,
    disponibilidade_pct: Number.isFinite(availability)
      ? Math.max(0, Math.min(100, availability))
      : null,
  };
}

function normalizeRecentEntries(entries, limit) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const sliceStart = limit && entries.length > limit ? entries.length - limit : 0;
  const subset = entries.slice(sliceStart);
  return subset.map((entry) => ({
    ts: entry.ts,
    success: Boolean(entry.success),
    rtt_ms: entry.success && Number.isFinite(entry.rtt_ms) ? entry.rtt_ms : null,
  }));
}

export function getTargetSnapshot(target, { now = Date.now(), limit } = {}) {
  if (!isEnabled()) {
    return {
      target: String(target ?? "").trim(),
      windows: {},
      recent: [],
      latestTs: null,
      totalCount: 0,
    };
  }

  const key = String(target ?? "").trim();
  const state = getOrCreateTargetState(key);
  if (!state) {
    return {
      target: key,
      windows: {},
      recent: [],
      latestTs: null,
      totalCount: 0,
    };
  }

  if (settings.longestWindowMs > 0) {
    state.buffer.pruneOlderThan(now - settings.longestWindowMs);
  }

  const entries = state.buffer.toArray();
  const windows = {};
  for (const windowDef of settings.windows) {
    windows[windowDef.id] = computeWindowStats(entries, windowDef.durationMs, now);
  }

  const recent = normalizeRecentEntries(entries, limit ?? settings.maxPoints);
  const latestTs = entries.length > 0 ? Number(entries[entries.length - 1].ts) : state.lastTs;

  return {
    target: key,
    windows,
    recent,
    latestTs: Number.isFinite(latestTs) ? latestTs : null,
    totalCount: entries.length,
  };
}

export function getAllTargets() {
  return Array.from(targetBuffers.keys()).sort();
}

export function clearAll() {
  targetBuffers.clear();
}

