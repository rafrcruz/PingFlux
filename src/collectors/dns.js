import fs from "fs";
import path from "path";
import dns from "dns";
import { openDb, migrate } from "../storage/db.js";
import * as logger from "../utils/logger.js";

const DEFAULT_HOSTNAMES = ["google.com"];
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 3000;

const TIMEOUT_ERROR_CODE = "DNS_LOOKUP_TIMEOUT";

let cachedSettings;
let cachedEnvFileValues;
let migrationsEnsured = false;

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

export async function resolveOnce(hostname, { signal } = {}) {
  const trimmedHost = String(hostname).trim();
  const settings = getDnsSettings();
  const ts = Date.now();
  const sample = {
    ts,
    hostname: trimmedHost,
    resolver: settings.resolver,
    lookup_ms: null,
    success: 0,
  };

  if (!trimmedHost) {
    return sample;
  }

  const start = process.hrtime.bigint();
  try {
    await withTimeout(dns.promises.lookup(trimmedHost), settings.timeoutMs, { signal });
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;
    sample.lookup_ms = durationMs;
    sample.success = 1;
  } catch (error) {
    sample.lookup_ms = null;
    sample.success = 0;
  }

  return sample;
}

export async function measureCycle(hostnames, { signal } = {}) {
  ensureDbReady();
  const providedList = Array.isArray(hostnames) ? hostnames : getDnsSettings().hostnames;
  const list = providedList.map((host) => String(host).trim()).filter((host) => host.length > 0);

  const samples = [];

  for (const host of list) {
    if (signal?.aborted) {
      break;
    }
    try {
      const sample = await resolveOnce(host, { signal });
      samples.push(sample);
    } catch (error) {
      samples.push({
        ts: Date.now(),
        hostname: host,
        resolver: getDnsSettings().resolver,
        lookup_ms: null,
        success: 0,
      });
    }
  }

  if (samples.length === 0) {
    return samples;
  }

  const db = openDb();
  const insert = db.prepare(
    "INSERT INTO dns_sample (ts, hostname, resolver, lookup_ms, success) VALUES (@ts, @hostname, @resolver, @lookup_ms, @success)"
  );

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run({
        ts: row.ts,
        hostname: row.hostname,
        resolver: row.resolver,
        lookup_ms: row.lookup_ms,
        success: row.success ? 1 : 0,
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
