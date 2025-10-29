import { spawn } from "child_process";
import net from "net";
import { getConfig } from "../config/index.js";
import { openDb, migrate } from "../storage/db.js";

const DEFAULT_TARGETS = ["8.8.8.8"];
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_TCP_PORT = 443;
const DEFAULT_FALLBACK_AFTER_FAILS = 3;
const DEFAULT_RECOVERY_AFTER_OKS = 2;

let cachedSettings;
let migrationsEnsured = false;
let activeLoopController = null;
let currentPingProcess = null;
const targetStates = new Map();

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

function normalizeTargets(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return [...DEFAULT_TARGETS];
  }

  const normalized = list
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : [...DEFAULT_TARGETS];
}

function buildSettings() {
  const config = getConfig();
  const pingConfig = config?.ping ?? {};

  const targets = normalizeTargets(pingConfig.targets);
  const intervalMs = Number.isFinite(pingConfig.intervalMs)
    ? Math.max(1, Math.floor(pingConfig.intervalMs))
    : DEFAULT_INTERVAL_S * 1000;
  const timeoutMs = Number.isFinite(pingConfig.timeoutMs)
    ? Math.max(1, Math.floor(pingConfig.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const methodPreference = typeof pingConfig.methodPreference === "string"
    ? pingConfig.methodPreference.trim().toLowerCase()
    : "auto";
  const tcpPort = Number.isFinite(pingConfig.tcpPort)
    ? Math.max(1, Math.floor(pingConfig.tcpPort))
    : DEFAULT_TCP_PORT;
  const fallbackAfterFails = Number.isFinite(pingConfig.fallbackAfterFails)
    ? Math.max(1, Math.floor(pingConfig.fallbackAfterFails))
    : DEFAULT_FALLBACK_AFTER_FAILS;
  const recoveryAfterOks = Number.isFinite(pingConfig.recoveryAfterOks)
    ? Math.max(1, Math.floor(pingConfig.recoveryAfterOks))
    : DEFAULT_RECOVERY_AFTER_OKS;

  return {
    targets,
    intervalMs,
    timeoutMs,
    methodPreference: ["icmp", "tcp", "auto"].includes(methodPreference)
      ? methodPreference
      : "auto",
    tcpPort,
    fallbackAfterFails,
    recoveryAfterOks,
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

function getOrCreateTargetState(target, settings) {
  const normalized = String(target ?? "").trim();
  const preference = settings?.methodPreference ?? "auto";

  if (!normalized) {
    return {
      target: normalized,
      mode: preference === "tcp" ? "tcp" : "icmp",
      preference,
      icmpFailureStreak: 0,
      tcpSuccessStreak: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSampleTs: null,
      lastSuccessTs: null,
      lastResultSuccess: 0,
    };
  }

  let state = targetStates.get(normalized);
  if (!state) {
    state = {
      target: normalized,
      mode: preference === "tcp" ? "tcp" : "icmp",
      preference,
      icmpFailureStreak: 0,
      tcpSuccessStreak: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSampleTs: null,
      lastSuccessTs: null,
      lastResultSuccess: 0,
    };
    targetStates.set(normalized, state);
  }

  state.preference = preference;
  if (preference === "icmp" || preference === "tcp") {
    if (state.mode !== preference) {
      state.mode = preference;
      state.icmpFailureStreak = 0;
      state.tcpSuccessStreak = 0;
    }
  } else if (!state.mode) {
    state.mode = "icmp";
  }

  return state;
}

function resolveMethodForTarget(target, settings) {
  const state = getOrCreateTargetState(target, settings);
  const method = state.mode === "tcp" ? "tcp" : "icmp";
  return { state, method };
}

function updateStateAfterResult({ state, target, method, success, ts, settings }) {
  if (!state) {
    return;
  }

  state.lastSampleTs = Number.isFinite(ts) ? ts : Date.now();
  if (success) {
    state.lastSuccessTs = state.lastSampleTs;
  }
  state.lastResultSuccess = success ? 1 : 0;

  state.consecutiveSuccesses = success
    ? (state.consecutiveSuccesses ?? 0) + 1
    : 0;
  state.consecutiveFailures = success ? 0 : (state.consecutiveFailures ?? 0) + 1;

  if (method === "icmp") {
    state.icmpFailureStreak = success ? 0 : (state.icmpFailureStreak ?? 0) + 1;
    state.tcpSuccessStreak = 0;
  } else if (method === "tcp") {
    state.tcpSuccessStreak = success ? (state.tcpSuccessStreak ?? 0) + 1 : 0;
    if (!success) {
      state.icmpFailureStreak = 0;
    }
  }

  if (settings?.methodPreference !== "auto") {
    return;
  }

  if (method === "icmp" && !success) {
    const threshold = settings.fallbackAfterFails ?? DEFAULT_FALLBACK_AFTER_FAILS;
    if (state.icmpFailureStreak >= threshold && state.mode !== "tcp") {
      // Trigger fallback to TCP after consecutive ICMP failures for this target.
      state.mode = "tcp";
      state.tcpSuccessStreak = 0;
      console.warn(
        `[ping] Falling back to TCP for ${target} after ${state.icmpFailureStreak} consecutive ICMP failures.`
      );
    }
    return;
  }

  if (method === "tcp" && success) {
    const recoveryThreshold = settings.recoveryAfterOks ?? DEFAULT_RECOVERY_AFTER_OKS;
    if (state.tcpSuccessStreak >= recoveryThreshold && state.mode !== "icmp") {
      // Return to ICMP once TCP probes have been healthy for the configured streak.
      state.mode = "icmp";
      state.icmpFailureStreak = 0;
      console.log(
        `[ping] Restoring ICMP for ${target} after ${state.tcpSuccessStreak} consecutive TCP successes.`
      );
    }
  }
}

export function getRuntimeStateSnapshot() {
  const snapshot = {};
  for (const [target, state] of targetStates.entries()) {
    snapshot[target] = {
      mode: state.mode ?? null,
      preference: state.preference ?? null,
      consecutiveFailures: state.consecutiveFailures ?? 0,
      consecutiveSuccesses: state.consecutiveSuccesses ?? 0,
      icmpFailureStreak: state.icmpFailureStreak ?? 0,
      tcpSuccessStreak: state.tcpSuccessStreak ?? 0,
      lastSampleTs: state.lastSampleTs ?? null,
      lastSuccessTs: state.lastSuccessTs ?? null,
      lastResultSuccess: state.lastResultSuccess ?? 0,
    };
  }
  return snapshot;
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

function runTcpProbe(target, port, timeoutMs, { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ success: false, aborted: true });
      return;
    }

    const socket = new net.Socket();
    socket.setNoDelay?.(true);
    let settled = false;
    let timeoutTimer = null;

    const cleanup = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
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
      try {
        socket.destroy();
      } catch (error) {
        // Ignore socket destroy errors; the OS will clean up.
      }
      resolve(result);
    };

    const startTime = Date.now();

    timeoutTimer = setTimeout(() => {
      settle({ success: false, timedOut: true });
    }, Math.max(timeoutMs, 1));
    timeoutTimer.unref?.();

    const abortHandler = () => {
      settle({ success: false, aborted: true });
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    socket.once("connect", () => {
      const rtt = Date.now() - startTime;
      settle({ success: true, rtt });
    });

    socket.once("error", (error) => {
      settle({ success: false, error });
    });

    try {
      socket.connect(port, target);
    } catch (error) {
      settle({ success: false, error });
    }
  });
}

async function executeProbe(target, method, settings, { signal } = {}) {
  const ts = Date.now();
  const normalizedTarget = String(target ?? "").trim();
  const normalizedMethod = method === "tcp" ? "tcp" : "icmp";
  const sample = {
    ts,
    target: normalizedTarget,
    method: normalizedMethod,
    rtt_ms: null,
    success: 0,
  };

  if (!normalizedTarget) {
    return sample;
  }

  try {
    if (normalizedMethod === "tcp") {
      const result = await runTcpProbe(normalizedTarget, settings.tcpPort, settings.timeoutMs, {
        signal,
      });
      if (result.success) {
        sample.success = 1;
        sample.rtt_ms = Number.isFinite(result.rtt) ? result.rtt : null;
      }
    } else {
      const result = await runPing(normalizedTarget, settings.timeoutMs, { signal });
      if (result.success) {
        sample.success = 1;
        sample.rtt_ms = parseRttFromOutput(result.output);
      }
    }
  } catch (error) {
    console.error(`[ping] Probe execution failed for ${normalizedTarget}:`, error);
  }

  return sample;
}

export async function measureOnce(target, { signal } = {}) {
  ensureDbReady();
  const settings = getPingSettings();
  const trimmedTarget = String(target ?? "").trim();
  const { state, method } = resolveMethodForTarget(trimmedTarget, settings);

  const sample = await executeProbe(trimmedTarget, method, settings, { signal });

  updateStateAfterResult({
    state,
    target: trimmedTarget,
    method: sample.method,
    success: sample.success === 1,
    ts: sample.ts,
    settings,
  });

  return sample;
}

export async function measureCycle(targets, { signal } = {}) {
  ensureDbReady();
  const settings = getPingSettings();
  const providedList = Array.isArray(targets) ? targets : settings.targets;
  const list = providedList
    .map((target) => String(target).trim())
    .filter((target) => target.length > 0);

  const samples = [];

  for (const target of list) {
    if (signal?.aborted) {
      break;
    }
    const trimmedTarget = String(target ?? "").trim();
    const { state, method } = resolveMethodForTarget(trimmedTarget, settings);
    let sample;
    try {
      sample = await executeProbe(trimmedTarget, method, settings, { signal });
    } catch (error) {
      console.error(`[ping] Cycle probe error for ${trimmedTarget}:`, error);
      sample = {
        ts: Date.now(),
        target: trimmedTarget,
        method,
        rtt_ms: null,
        success: 0,
      };
    }

    updateStateAfterResult({
      state,
      target: trimmedTarget,
      method: sample.method,
      success: sample.success === 1,
      ts: sample.ts,
      settings,
    });

    samples.push(sample);
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
  if (settings.methodPreference === "auto") {
    console.log(
      `[ping] Method: auto (fallback after ${settings.fallbackAfterFails} ICMP fails, recover after ${settings.recoveryAfterOks} TCP successes on port ${settings.tcpPort}).`
    );
  } else {
    console.log(
      `[ping] Method locked to ${settings.methodPreference.toUpperCase()} (TCP port ${settings.tcpPort}).`
    );
  }

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
