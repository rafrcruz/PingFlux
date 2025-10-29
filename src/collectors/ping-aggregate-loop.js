import { aggregateRange } from "./ping-aggregate.js";
import { getConfig } from "../config/index.js";

const MINUTE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_CATCHUP_MINUTES = 10;
const DEFAULT_MAX_BATCH = 5000;

let activeController = null;

function floorToMinute(ts) {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

function buildSettings() {
  const config = getConfig();
  const agg = config?.aggregation ?? {};
  const intervalMs = Number.isFinite(agg.intervalMs)
    ? Math.max(500, Math.floor(agg.intervalMs))
    : DEFAULT_INTERVAL_MS;
  const catchupMinutes = Number.isFinite(agg.catchupMinutes)
    ? Math.max(0, Math.floor(agg.catchupMinutes))
    : DEFAULT_CATCHUP_MINUTES;
  const maxBatch = Number.isFinite(agg.maxBatch)
    ? Math.max(1, Math.floor(agg.maxBatch))
    : DEFAULT_MAX_BATCH;

  return { intervalMs, catchupMinutes, maxBatch };
}

function createSleep(ms, signal, shouldStop) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    if (shouldStop()) {
      resolve();
      return;
    }

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    };

    const onAbort = () => {
      cleanup();
    };

    timer = setTimeout(() => {
      cleanup();
    }, ms);
    timer.unref?.();

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    cancel = cleanup;
  });

  return { promise, cancel };
}

function createController({ signal } = {}) {
  const settings = buildSettings();
  let stopRequested = false;
  let cursorMinute = null;
  let resolveDone;
  let rejectDone;

  const donePromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const shouldStop = () => stopRequested || signal?.aborted;

  const abortHandler = () => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
  };

  if (signal) {
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler);
    }
  }

  const ensureCursor = (now) => {
    if (cursorMinute !== null) {
      return;
    }
    const offset = settings.catchupMinutes * MINUTE_MS;
    cursorMinute = floorToMinute(now - offset);
  };

  const processBatch = (targetNow) => {
    ensureCursor(targetNow);
    if (shouldStop()) {
      return false;
    }

    const targetMinute = floorToMinute(targetNow);
    if (cursorMinute > targetMinute) {
      return false;
    }

    const remainingWindows = Math.floor((targetMinute - cursorMinute) / MINUTE_MS) + 1;
    if (remainingWindows <= 0) {
      return false;
    }

    const windowsThisRun = Math.min(remainingWindows, settings.maxBatch);
    const rangeFrom = cursorMinute;
    const rangeTo = Math.min(rangeFrom + windowsThisRun * MINUTE_MS - 1, targetNow);

    try {
      aggregateRange(rangeFrom, rangeTo);
    } catch (error) {
      console.error("[ping:agg] Failed to aggregate ping windows:", error);
    }

    cursorMinute += windowsThisRun * MINUTE_MS;
    return cursorMinute <= targetMinute;
  };

  const runCatchup = () => {
    const now = Date.now();
    ensureCursor(now);
    if (settings.catchupMinutes > 0) {
      console.log(
        `[ping:agg] Catch-up starting from ${new Date(cursorMinute).toISOString()} (last ${settings.catchupMinutes} minute(s)).`
      );
    }
    let hasMore = true;
    while (!shouldStop() && hasMore) {
      hasMore = processBatch(now);
    }
    if (settings.catchupMinutes > 0) {
      console.log(
        `[ping:agg] Catch-up complete up to ${new Date(Math.min(cursorMinute, floorToMinute(now))).toISOString()}.`
      );
    }
  };

  let cancelPendingSleep = null;

  const loop = async () => {
    try {
      runCatchup();
      while (!shouldStop()) {
        const now = Date.now();
        processBatch(now);
        if (shouldStop()) {
          break;
        }
        const { promise: sleepPromise, cancel } = createSleep(
          settings.intervalMs,
          signal,
          shouldStop
        );
        cancelPendingSleep = cancel;
        await sleepPromise;
        cancelPendingSleep = null;
      }
      resolveDone();
    } catch (error) {
      rejectDone(error);
      console.error("[ping:agg] Scheduler stopped due to error:", error);
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  };

  loop();

  const requestStop = () => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    if (cancelPendingSleep) {
      cancelPendingSleep();
      cancelPendingSleep = null;
    }
  };

  return { promise: donePromise, requestStop };
}

export async function runLoop(options = {}) {
  if (activeController) {
    return activeController.promise;
  }

  activeController = createController(options);
  try {
    await activeController.promise;
  } finally {
    activeController = null;
  }
}

export async function stop() {
  if (!activeController) {
    return;
  }
  try {
    activeController.requestStop();
    await activeController.promise;
  } catch (error) {
    console.error("[ping:agg] Error while stopping aggregator:", error);
  }
}
