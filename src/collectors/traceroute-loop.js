import { runTraceroute } from "./traceroute.js";
import { getConfig } from "../config/index.js";
import * as logger from "../utils/logger.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

let activeController = null;

// Sleeps for the requested interval while honouring the shutdown signal.
// Invoked between scheduled traceroute executions (~every 30 minutes).
function sleep(ms, { signal } = {}) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve();
    };

    timer = setTimeout(() => {
      finish();
    }, ms);
    timer.unref?.();

    let abortHandler = null;
    if (signal) {
      abortHandler = () => {
        finish();
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
  });
}

// Executes a traceroute using the configured default target.
// Called on every scheduled cycle and once immediately at startup.
async function executeTracerouteCycle() {
  const config = getConfig();
  const targets = Array.isArray(config?.ping?.targets) ? config.ping.targets : [];
  const primaryTarget = targets
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  try {
    const result = await runTraceroute(primaryTarget ?? null);
    const executedAt = Number.isFinite(result?.ts)
      ? new Date(result.ts).toISOString()
      : new Date().toISOString();
    logger.info(
      "traceroute-loop",
      `Traceroute executed for ${result.target} at ${executedAt} (success=${result.success === 1}).`
    );
  } catch (error) {
    logger.error("traceroute-loop", "Scheduled traceroute failed", error);
  }
}

function createController({ intervalMs, signal } = {}) {
  const effectiveInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  let stopRequested = false;
  let resolveDone;
  let rejectDone;

  const donePromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const shouldStop = () => stopRequested || signal?.aborted;

  const loop = async () => {
    try {
      await executeTracerouteCycle();
      while (!shouldStop()) {
        await sleep(effectiveInterval, { signal });
        if (shouldStop()) {
          break;
        }
        await executeTracerouteCycle();
      }
      resolveDone();
    } catch (error) {
      rejectDone(error);
      logger.error("traceroute-loop", "Scheduler stopped due to error", error);
    }
  };

  loop();

  return {
    promise: donePromise,
    requestStop() {
      if (!stopRequested) {
        stopRequested = true;
      }
    },
  };
}

// Starts the traceroute automation loop (runs every ~30 minutes).
// The loop can be stopped via the exported stop() function or an abort signal.
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
    logger.error("traceroute-loop", "Error while stopping traceroute loop", error);
  }
}
