import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { openDb, migrate } from "../storage/db.js";

const DEFAULT_TARGETS = ["8.8.8.8"];
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_METHOD = "system-ping";

let cachedSettings;
let cachedEnvFileValues;
let migrationsEnsured = false;
let activeLoopController = null;
let currentPingProcess = null;

function terminateChildProcess(child) {
  if (!child) {
    return;
  }

  const pid = child.pid;
  try {
    child.kill();
  } catch (error) {
    // Ignore kill errors; process may already be gone.
  }

  if (process.platform === "win32" && pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
      killer.stdout?.resume();
      killer.stderr?.resume();
      killer.unref?.();
    } catch (error) {
      // Ignore taskkill errors; best-effort cleanup.
    }
  }
}

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

function parseTargets(raw) {
  if (!raw) {
    return [...DEFAULT_TARGETS];
  }

  const parts = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : [...DEFAULT_TARGETS];
}

function toInteger(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSettings() {
  const targets = parseTargets(getEnvValue("PING_TARGETS"));
  const intervalSeconds = toInteger(getEnvValue("PING_INTERVAL_S"), DEFAULT_INTERVAL_S);
  const timeoutMs = toInteger(getEnvValue("PING_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  const method = String(getEnvValue("PING_METHOD") ?? DEFAULT_METHOD).trim() || DEFAULT_METHOD;

  return {
    targets,
    intervalMs: Math.max(intervalSeconds, 1) * 1000,
    timeoutMs: Math.max(timeoutMs, 1),
    method,
  };
}

export function getPingSettings() {
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

function buildPingArgs(target, timeoutMs) {
  if (process.platform === "win32") {
    return ["-n", "1", "-w", String(Math.max(timeoutMs, 1)), target];
  }

  const deadlineSeconds = Math.max(Math.ceil(timeoutMs / 1000), 1);
  if (process.platform === "darwin") {
    return ["-n", "-c", "1", "-W", String(Math.max(timeoutMs, 1)), target];
  }

  return ["-n", "-c", "1", "-W", String(deadlineSeconds), target];
}

function parseRttFromOutput(output) {
  if (!output) {
    return null;
  }

  const timeMatch = /time[=<\s]*([0-9]+(?:\.[0-9]+)?)\s*ms/i.exec(output);
  if (timeMatch) {
    const value = Number.parseFloat(timeMatch[1]);
    return Number.isFinite(value) ? value : null;
  }

  const avgMatch = /min\/avg\/max(?:\/mdev)?\s*=\s*([0-9.]+)\/([0-9.]+)\/[0-9.]+/i.exec(output);
  if (avgMatch) {
    const avg = Number.parseFloat(avgMatch[2]);
    return Number.isFinite(avg) ? avg : null;
  }

  const windowsMatch = /Average = ([0-9]+)ms/i.exec(output);
  if (windowsMatch) {
    const avg = Number.parseFloat(windowsMatch[1]);
    return Number.isFinite(avg) ? avg : null;
  }

  return null;
}

function runPing(target, timeoutMs, { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ success: false, output: "", aborted: true });
      return;
    }

    const args = buildPingArgs(target, timeoutMs);
    const child = spawn("ping", args);
    currentPingProcess = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutTimer = null;

    const cleanup = () => {
      if (currentPingProcess === child) {
        currentPingProcess = null;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    timeoutTimer = setTimeout(() => {
      if (!settled) {
        terminateChildProcess(child);
        settle({ success: false, output: stdout + stderr, timedOut: true });
      }
    }, timeoutMs + 500);
    timeoutTimer.unref?.();

    const abortHandler = () => {
      terminateChildProcess(child);
      settle({ success: false, output: stdout + stderr, aborted: true });
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      settle({ success: false, output: stdout + stderr, error });
    });

    child.on("close", (code) => {
      settle({ success: code === 0, output: stdout + stderr, code });
    });
  });
}

export async function measureOnce(target, { signal } = {}) {
  ensureDbReady();
  const settings = getPingSettings();
  const trimmedTarget = String(target ?? "").trim();
  const ts = Date.now();
  const sample = {
    ts,
    target: trimmedTarget,
    method: settings.method,
    rtt_ms: null,
    success: 0,
  };

  if (!trimmedTarget) {
    return sample;
  }

  const result = await runPing(trimmedTarget, settings.timeoutMs, { signal });
  if (result.success) {
    sample.success = 1;
    sample.rtt_ms = parseRttFromOutput(result.output);
  } else {
    sample.success = 0;
    sample.rtt_ms = null;
  }

  return sample;
}

export async function measureCycle(targets, { signal } = {}) {
  ensureDbReady();
  const providedList = Array.isArray(targets) ? targets : getPingSettings().targets;
  const list = providedList
    .map((target) => String(target).trim())
    .filter((target) => target.length > 0);

  const samples = [];

  for (const target of list) {
    if (signal?.aborted) {
      break;
    }
    try {
      const sample = await measureOnce(target, { signal });
      samples.push(sample);
    } catch (error) {
      samples.push({
        ts: Date.now(),
        target,
        method: getPingSettings().method,
        rtt_ms: null,
        success: 0,
      });
    }
  }

  if (samples.length === 0) {
    return samples;
  }

  const db = openDb();
  const insert = db.prepare(
    "INSERT INTO ping_sample (ts, target, method, rtt_ms, success) VALUES (@ts, @target, @method, @rtt_ms, @success)"
  );

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run({
        ts: row.ts,
        target: row.target,
        method: row.method,
        rtt_ms: row.rtt_ms,
        success: row.success ? 1 : 0,
      });
    }
  });

  insertMany(samples);

  return samples;
}

function createLoopController({ signal } = {}) {
  const settings = getPingSettings();
  const targets = settings.targets;
  console.log(
    `[ping] Starting ping loop for: ${targets.length ? targets.join(", ") : "(none)"}`
  );
  console.log(
    `[ping] Interval: ${settings.intervalMs / 1000}s, timeout: ${settings.timeoutMs}ms`
  );

  let stopRequested = false;
  let pendingSleepResolve = null;
  let pendingSleepTimer = null;
  const loopAbortController = new AbortController();
  const loopSignal = loopAbortController.signal;

  const requestStop = () => {
    if (!stopRequested) {
      console.log("[ping] Stop requested.");
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

    if (currentPingProcess) {
      terminateChildProcess(currentPingProcess);
    }

    if (!loopAbortController.signal.aborted) {
      loopAbortController.abort();
    }
  };

  const abortHandler = () => {
    console.log("[ping] Abort signal received, stopping loop...");
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
          const samples = await measureCycle(targets, { signal: loopSignal });
          console.log(
            `[ping] Cycle complete: ${samples.length} sample${samples.length === 1 ? "" : "s"} inserted.`
          );
        } catch (error) {
          console.error("[ping] Cycle error:", error);
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
        }
      }
      } finally {
        if (pendingSleepTimer !== null) {
          clearTimeout(pendingSleepTimer);
        }
        pendingSleepTimer = null;
        pendingSleepResolve = null;
        console.log("[ping] Loop stopped.");
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
    // Swallow errors during shutdown to avoid noisy stack traces in callers.
  }
}
