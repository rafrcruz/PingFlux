import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { migrate } from "../storage/db.js";
import { recordSamples as recordHttpSamples } from "../services/httpService.js";
import { createLogger } from "../runtime/logger.js";
import { markCollectorHeartbeat } from "../runtime/collectorState.js";

const log = createLogger("http");

const DEFAULT_URLS = ["https://example.com"];
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const USER_AGENT = "PingFluxHttpCollector/1.0";

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

function parseUrls(raw) {
  if (!raw) {
    return [...DEFAULT_URLS];
  }

  const parts = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : [...DEFAULT_URLS];
}

function toInteger(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSettings() {
  const urls = parseUrls(getEnvValue("HTTP_URLS"));
  const intervalSeconds = toInteger(getEnvValue("HTTP_INTERVAL_S"), DEFAULT_INTERVAL_S);
  const timeoutMs = toInteger(getEnvValue("HTTP_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);

  return {
    urls,
    intervalMs: Math.max(intervalSeconds, 1) * 1000,
    timeoutMs: Math.max(timeoutMs, 1),
  };
}

export function getHttpSettings() {
  if (!cachedSettings) {
    cachedSettings = buildSettings();
  }

  return cachedSettings;
}

function ensureDbReady() {
  if (!migrationsEnsured) {
    migrate();
    migrationsEnsured = true;
  }
}

function resolveHttpModule(urlObject) {
  if (!urlObject || !urlObject.protocol) {
    return null;
  }

  if (urlObject.protocol === "http:") {
    return http;
  }

  if (urlObject.protocol === "https:") {
    return https;
  }

  return null;
}

export async function fetchOnce(url, { signal } = {}) {
  const settings = getHttpSettings();
  const timeoutMs = settings.timeoutMs;
  const trimmedUrl = String(url ?? "").trim();
  const ts = Date.now();
  const sample = {
    ts,
    url: trimmedUrl,
    status: null,
    ttfb_ms: null,
    total_ms: null,
    bytes: null,
    success: 0,
  };

  if (!trimmedUrl) {
    return sample;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch (error) {
    return sample;
  }

  const httpModule = resolveHttpModule(parsedUrl);
  if (!httpModule) {
    return sample;
  }

  if (signal?.aborted) {
    return sample;
  }

  activeHttpRequest = null;

  return new Promise((resolve) => {
    const startTime = process.hrtime.bigint();
    let bytesReceived = 0;
    let settled = false;
    let timeoutTimer = null;
    let request;

    const cleanup = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (activeHttpRequest === request) {
        activeHttpRequest = null;
      }
    };

    const finalize = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(sample);
    };

    const abortHandler = () => {
      if (request) {
        request.destroy(new Error("HTTP request aborted"));
      }
      finalize();
    };

    try {
      request = httpModule.request(
        parsedUrl,
        {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "*/*",
            Connection: "close",
          },
          signal,
        },
        (response) => {
          sample.status = response.statusCode ?? null;

          const firstByteTime = process.hrtime.bigint();
          sample.ttfb_ms = Number(firstByteTime - startTime) / 1e6;

          response.on("data", (chunk) => {
            if (chunk) {
              bytesReceived += chunk.length;
            }
          });

          response.on("end", () => {
            const endTime = process.hrtime.bigint();
            sample.total_ms = Number(endTime - startTime) / 1e6;
            sample.bytes = bytesReceived;
            sample.success = 1;
            finalize();
          });

          response.on("aborted", () => {
            finalize();
          });

          response.on("error", () => {
            finalize();
          });
        }
      );
    } catch (error) {
      cleanup();
      finalize();
      return;
    }

    request.on("error", () => {
      finalize();
    });

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    timeoutTimer = setTimeout(() => {
      request.destroy(new Error("HTTP request timeout"));
    }, timeoutMs);
    timeoutTimer.unref?.();

    activeHttpRequest = request;

    request.end();
  });
}

export async function measureCycle(urls, { signal } = {}) {
  ensureDbReady();
  const providedList = Array.isArray(urls) ? urls : getHttpSettings().urls;
  const list = providedList
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);

  const samples = [];

  for (const entry of list) {
    if (signal?.aborted) {
      break;
    }
    try {
      const sample = await fetchOnce(entry, { signal });
      samples.push(sample);
    } catch (error) {
      samples.push({
        ts: Date.now(),
        url: String(entry ?? "").trim(),
        status: null,
        ttfb_ms: null,
        total_ms: null,
        bytes: null,
        success: 0,
      });
    }
  }

  if (samples.length === 0) {
    return samples;
  }

  recordHttpSamples(samples);
  markCollectorHeartbeat("http", { ok: true });

  return samples;
}

let activeLoopController;
let activeHttpRequest = null;

function createLoopController({ signal } = {}) {
  const settings = getHttpSettings();
  const urls = settings.urls;
  log.info(`Starting HTTP loop for: ${urls.length ? urls.join(", ") : "(none)"}`);
  log.info(`Interval: ${settings.intervalMs / 1000}s, timeout: ${settings.timeoutMs}ms`);

  let stopRequested = false;
  let pendingSleepResolve = null;
  let pendingSleepTimer = null;

  const loopAbortController = new AbortController();
  const loopSignal = loopAbortController.signal;

  const requestStop = () => {
    if (!stopRequested) {
      log.info("Stop requested.");
      stopRequested = true;
    }

    if (pendingSleepTimer !== null) {
      clearTimeout(pendingSleepTimer);
      pendingSleepTimer = null;
    }

    if (typeof pendingSleepResolve === "function") {
      const resolveSleep = pendingSleepResolve;
      pendingSleepResolve = null;
      resolveSleep();
    }

    if (activeHttpRequest) {
      try {
        activeHttpRequest.destroy(new Error("HTTP collector stopped"));
      } catch (error) {
        // Ignore errors while destroying active request during shutdown.
      }
    }

    if (!loopAbortController.signal.aborted) {
      loopAbortController.abort();
    }
  };

  const abortHandler = () => {
    log.warn("Abort signal received, stopping loop...");
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
          const samples = await measureCycle(urls, { signal: loopSignal });
          log.debug(
            `Cycle complete: ${samples.length} sample${samples.length === 1 ? "" : "s"} recorded.`
          );
        } catch (error) {
          log.error("Cycle error", error);
          markCollectorHeartbeat("http", { ok: false, error });
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
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (pendingSleepTimer !== null) {
        clearTimeout(pendingSleepTimer);
      }
      pendingSleepTimer = null;
      pendingSleepResolve = null;
      log.info("Loop stopped.");
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
