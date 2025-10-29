import fs from "fs";
import path from "path";
import dns from "dns";
import { randomUUID } from "crypto";
import { openDb, migrate } from "../storage/db.js";
import * as logger from "../utils/logger.js";

const DEFAULT_HOSTNAMES = ["google.com"];
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 3000;
const COLD_LOOKUP_INTERVAL_MS = 5 * 60 * 1000;

const TIMEOUT_ERROR_CODE = "DNS_LOOKUP_TIMEOUT";

let cachedSettings;
let cachedEnvFileValues;
let migrationsEnsured = false;
const coldLookupState = new Map();

function parseEnvFileOnce() {
  if (cachedEnvFileValues) {
    return cachedEnvFileValues;
  }

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    cachedEnvFileValues = {};
    return cachedEnvFileValues;
  }

  const entries = {};
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [rawKey, ...rest] = line.split("=");
    if (!rawKey) {
      continue;
    }

    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    const rawValue = rest.join("=");
    const normalized = rawValue.replace(/^['"]?(.*?)['"]?$/, "$1");
    entries[key] = normalized;
  }

  cachedEnvFileValues = entries;
  return cachedEnvFileValues;
}

function getEnvValue(name) {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    return process.env[name];
  }

  const fileValues = parseEnvFileOnce();
  if (fileValues[name] !== undefined && fileValues[name] !== "") {
    return fileValues[name];
  }

  return undefined;
}

function parseHostnames(raw) {
  if (!raw) {
    return [...DEFAULT_HOSTNAMES];
  }

  const parts = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : [...DEFAULT_HOSTNAMES];
}

function toInteger(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSettings() {
  const hostnames = parseHostnames(getEnvValue("DNS_HOSTNAMES"));
  const intervalSeconds = toInteger(getEnvValue("DNS_INTERVAL_S"), DEFAULT_INTERVAL_S);
  const timeoutMs = toInteger(getEnvValue("DNS_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);

  return {
    hostnames,
    intervalMs: Math.max(intervalSeconds, 1) * 1000,
    timeoutMs: Math.max(timeoutMs, 1),
    resolver: resolveResolverString(),
  };
}

function resolveResolverString() {
  try {
    const servers = dns.getServers();
    if (!servers || servers.length === 0) {
      return null;
    }

    return servers.join(", ");
  } catch (error) {
    // Accessing getServers should not throw, but guard just in case.
    return null;
  }
}

export function getDnsSettings() {
  if (!cachedSettings) {
    cachedSettings = buildSettings();
  }

  return cachedSettings;
}

function withTimeout(promise, timeoutMs, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    const finish = (handler) => {
      return (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        handler(value);
      };
    };

    const abortHandler = () => {
      finish(reject)(Object.assign(new Error("DNS lookup aborted"), { name: "AbortError" }));
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    timeoutId = setTimeout(() => {
      const timeoutError = new Error("DNS lookup timed out");
      timeoutError.code = TIMEOUT_ERROR_CODE;
      finish(reject)(timeoutError);
    }, timeoutMs);
    timeoutId.unref?.();

    promise.then(finish(resolve)).catch(finish(reject));
  });
}

// Determines whether a cold lookup should run for the hostname.
// Called on every DNS cycle (typically once per minute).
function shouldRunColdLookup(hostname, now, force) {
  if (force) {
    return true;
  }
  const last = coldLookupState.get(hostname);
  if (!Number.isFinite(last)) {
    return true;
  }
  return now - last >= COLD_LOOKUP_INTERVAL_MS;
}

// Stores the timestamp of the last cold lookup so we can respect the 5 minute cadence.
function rememberColdLookup(hostname, ts) {
  coldLookupState.set(hostname, ts);
}

// Generates a unique, cache-busting hostname for cold DNS lookups.
// Invoked whenever a cold lookup is required (~every 5 minutes per target).
function buildColdHostname(hostname) {
  const suffix = String(hostname ?? "").trim();
  if (!suffix) {
    return suffix;
  }
  const prefix = `pingflux-${randomUUID()}`;
  return `${prefix}.${suffix}`;
}

// Performs a single DNS lookup and measures the elapsed time.
// Used for both hot and cold measurements within each cycle.
async function performLookup(hostname, settings, { signal } = {}) {
  const trimmedHost = String(hostname ?? "").trim();
  if (!trimmedHost) {
    return { success: false, durationMs: null };
  }

  const start = process.hrtime.bigint();
  try {
    await withTimeout(dns.promises.lookup(trimmedHost), settings.timeoutMs, { signal });
    const end = process.hrtime.bigint();
    return { success: true, durationMs: Number(end - start) / 1e6 };
  } catch (error) {
    return { success: false, durationMs: null };
  }
}

// Collects hot (cached) and optionally cold (cache-busting) measurements for a hostname.
// Executed once per hostname on each collector cycle.
async function measureHostname(hostname, settings, { signal, forceCold = false } = {}) {
  const trimmedHost = String(hostname ?? "").trim();
  const now = Date.now();
  const sample = {
    ts: now,
    hostname: trimmedHost,
    resolver: settings.resolver,
    lookup_ms: null,
    lookup_ms_hot: null,
    lookup_ms_cold: null,
    success: 0,
    success_hot: null,
    success_cold: null,
  };

  if (!trimmedHost) {
    return { sample, coldExecuted: false };
  }

  const hot = await performLookup(trimmedHost, settings, { signal });
  sample.lookup_ms_hot = hot.durationMs;
  sample.success_hot = hot.success ? 1 : 0;
  sample.success = hot.success ? 1 : 0;

  let coldExecuted = false;
  if (shouldRunColdLookup(trimmedHost, now, forceCold)) {
    const coldHostname = buildColdHostname(trimmedHost);
    const cold = await performLookup(coldHostname, settings, { signal });
    sample.lookup_ms_cold = cold.durationMs;
    sample.success_cold = cold.success ? 1 : 0;
    rememberColdLookup(trimmedHost, now);
    coldExecuted = true;
  }

  sample.lookup_ms = sample.lookup_ms_cold ?? sample.lookup_ms_hot ?? null;
  if (sample.success_hot == null) {
    sample.success_hot = sample.success;
  }

  return { sample, coldExecuted };
}

export async function resolveOnce(hostname, { signal } = {}) {
  const settings = getDnsSettings();
  const { sample } = await measureHostname(hostname, settings, { signal, forceCold: true });
  return sample;
}

export async function measureCycle(hostnames, { signal } = {}) {
  ensureDbReady();
  const settings = getDnsSettings();
  const providedList = Array.isArray(hostnames) ? hostnames : settings.hostnames;
  const list = providedList.map((host) => String(host).trim()).filter((host) => host.length > 0);

  const samples = [];

  for (const host of list) {
    if (signal?.aborted) {
      break;
    }
    try {
      const { sample } = await measureHostname(host, settings, { signal });
      samples.push(sample);
    } catch (error) {
      samples.push({
        ts: Date.now(),
        hostname: host,
        resolver: settings.resolver,
        lookup_ms: null,
        lookup_ms_hot: null,
        lookup_ms_cold: null,
        success: 0,
        success_hot: 0,
        success_cold: null,
      });
    }
  }

  if (samples.length === 0) {
    return samples;
  }

  const db = openDb();
  const insert = db.prepare(
    "INSERT INTO dns_sample (ts, hostname, resolver, lookup_ms, lookup_ms_hot, lookup_ms_cold, success, success_hot, success_cold) VALUES (@ts, @hostname, @resolver, @lookup_ms, @lookup_ms_hot, @lookup_ms_cold, @success, @success_hot, @success_cold)"
  );

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run({
        ts: row.ts,
        hostname: row.hostname,
        resolver: row.resolver,
        lookup_ms: row.lookup_ms,
        lookup_ms_hot: row.lookup_ms_hot,
        lookup_ms_cold: row.lookup_ms_cold,
        success: row.success ? 1 : 0,
        success_hot: row.success_hot ?? (row.success ? 1 : 0),
        success_cold:
          row.success_cold === undefined || row.success_cold === null
            ? null
            : row.success_cold
                ? 1
                : 0,
      });
    }
  });

  insertMany(samples);

  return samples;
}

function ensureDbReady() {
  if (!migrationsEnsured) {
    migrate();
    migrationsEnsured = true;
  }
}

let activeLoopController;

function createLoopController({ signal } = {}) {
  const settings = getDnsSettings();
  const hostnames = settings.hostnames;
  logger.info(
    "dns",
    `Starting DNS loop for: ${hostnames.length ? hostnames.join(", ") : "(none)"}`
  );
  logger.info("dns", `Interval: ${settings.intervalMs / 1000}s, timeout: ${settings.timeoutMs}ms`);

  let stopRequested = false;
  let pendingSleepResolve = null;
  let pendingSleepTimer = null;

  const loopAbortController = new AbortController();
  const loopSignal = loopAbortController.signal;

  const requestStop = () => {
    if (!stopRequested) {
      logger.info("dns", "Stop requested.");
      stopRequested = true;
    }

    if (pendingSleepTimer !== null) {
      clearTimeout(pendingSleepTimer);
      pendingSleepTimer = null;
    }

    if (typeof pendingSleepResolve === "function") {
      const resolve = pendingSleepResolve;
      pendingSleepResolve = null;
      resolve();
    }

    if (!loopAbortController.signal.aborted) {
      loopAbortController.abort();
    }
  };

  const abortHandler = () => {
    logger.warn("dns", "Abort signal received, stopping loop...");
    requestStop();
  };

  if (signal) {
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler);
    }
  }

  const promise = (async () => {
    try {
      while (!stopRequested) {
        const cycleStart = Date.now();
        try {
          const samples = await measureCycle(hostnames, { signal: loopSignal });
          logger.info(
            "dns",
            `Cycle complete: ${samples.length} sample${samples.length === 1 ? "" : "s"} inserted.`
          );
        } catch (error) {
          logger.error("dns", "Cycle error", error);
        }

        if (stopRequested) {
          break;
        }

        const elapsed = Date.now() - cycleStart;
        const delay = Math.max(settings.intervalMs - elapsed, 0);
        if (delay > 0 && !stopRequested) {
          await new Promise((resolve) => {
            pendingSleepResolve = resolve;
            pendingSleepTimer = setTimeout(() => {
              pendingSleepTimer = null;
              pendingSleepResolve = null;
              resolve();
            }, delay);
          });
          pendingSleepTimer = null;
          pendingSleepResolve = null;
        }
      }
    } finally {
      if (pendingSleepTimer !== null) {
        clearTimeout(pendingSleepTimer);
      }
      pendingSleepTimer = null;
      pendingSleepResolve = null;
      logger.info("dns", "Loop stopped.");
    }
  })();

  return {
    promise,
    requestStop,
    cleanup: () => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    },
  };
}

export async function runLoop(options = {}) {
  const { signal } = options ?? {};
  if (activeLoopController) {
    return activeLoopController.promise;
  }

  activeLoopController = createLoopController({ signal });
  try {
    await activeLoopController.promise;
  } finally {
    activeLoopController.cleanup?.();
    activeLoopController = null;
  }
}

export async function stop() {
  if (!activeLoopController) {
    return;
  }

  try {
    activeLoopController.requestStop();
    await activeLoopController.promise;
  } catch (error) {
    // Suppress shutdown errors to keep callers clean.
  }
}
