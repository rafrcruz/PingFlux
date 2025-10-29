import * as logger from "../utils/logger.js";

const abortController = new AbortController();
const shutdownTasks = new Set();
let shutdownStarted = false;
let resolveShutdownPromise;
let rejectShutdownPromise;
const shutdownPromise = new Promise((resolve, reject) => {
  resolveShutdownPromise = resolve;
  rejectShutdownPromise = reject;
});

let handlersInitialized = false;
let handlerOptions = { gracefulMs: 2000, forceMs: 5000 };
let gracefulTimer = null;
let forceTimer = null;
let shuttingDownReason = null;

function clearTimers() {
  if (gracefulTimer) {
    clearTimeout(gracefulTimer);
    gracefulTimer = null;
  }
  if (forceTimer) {
    clearTimeout(forceTimer);
    forceTimer = null;
  }
}

function scheduleTimers() {
  clearTimers();

  const { gracefulMs, forceMs } = handlerOptions;

  if (Number.isFinite(gracefulMs) && gracefulMs > 0) {
    gracefulTimer = setTimeout(() => {
      logger.warn("shutdown", `Graceful shutdown still in progress after ${gracefulMs}ms...`);
    }, gracefulMs);
    gracefulTimer.unref?.();
  }

  if (Number.isFinite(forceMs) && forceMs > 0) {
    forceTimer = setTimeout(() => {
      logger.error("shutdown", `Shutdown exceeded ${forceMs}ms, forcing process exit.`);
      process.exit(0);
    }, forceMs);
    forceTimer.unref?.();
  }
}

async function executeTasks() {
  const tasks = Array.from(shutdownTasks);
  if (tasks.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    tasks.map((task) => {
      try {
        return Promise.resolve(task());
      } catch (error) {
        return Promise.reject(error);
      }
    })
  );

  return results;
}

async function beginShutdown(reason = "unknown") {
  if (shutdownStarted) {
    return shutdownPromise;
  }
  shutdownStarted = true;
  shuttingDownReason = reason;

  logger.info("shutdown", `Received ${reason}, starting shutdown sequence.`);
  abortController.abort();
  scheduleTimers();

  try {
    const start = Date.now();
    const results = await executeTasks();

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("shutdown", "Task error", result.reason);
      }
    }

    const elapsed = Date.now() - start;
    logger.info("shutdown", `Shutdown tasks completed in ${elapsed}ms.`);

    clearTimers();
    resolveShutdownPromise();
  } catch (error) {
    clearTimers();
    rejectShutdownPromise(error);
  }

  return shutdownPromise;
}

function createSignalHandler(signal) {
  return () => {
    beginShutdown(signal).catch((error) => {
      logger.error("shutdown", "Error during shutdown", error);
      process.exit(1);
    });
  };
}

export function getShutdownSignal() {
  return abortController.signal;
}

export function registerOnShutdown(task) {
  if (typeof task !== "function") {
    throw new TypeError("registerOnShutdown expects a function");
  }

  shutdownTasks.add(task);

  return () => {
    shutdownTasks.delete(task);
  };
}

export function initSignalHandlers(options = {}) {
  if (handlersInitialized) {
    return;
  }

  const gracefulMs = Number.isFinite(options.gracefulMs)
    ? Number(options.gracefulMs)
    : handlerOptions.gracefulMs;
  const forceMs = Number.isFinite(options.forceMs)
    ? Number(options.forceMs)
    : handlerOptions.forceMs;

  handlerOptions = {
    gracefulMs: gracefulMs > 0 ? gracefulMs : handlerOptions.gracefulMs,
    forceMs: forceMs > 0 ? forceMs : handlerOptions.forceMs,
  };

  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, createSignalHandler(signal));
  }

  handlersInitialized = true;
}

export async function initiateShutdown(reason = "manual") {
  return beginShutdown(reason);
}

export function waitForShutdown() {
  return shutdownPromise;
}

export function hasShutdownStarted() {
  return shutdownStarted;
}

export function getShutdownReason() {
  return shuttingDownReason;
}
