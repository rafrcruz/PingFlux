import { getConfig } from "../config/index.js";
import { openDb, migrate, closeDb } from "../storage/db.js";
import * as pingCollector from "../collectors/ping.js";
import * as dnsCollector from "../collectors/dns.js";
import * as httpCollector from "../collectors/http.js";
import { startServer } from "../web/server.js";

function toBooleanFlag(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parsePort(rawPort, fallback) {
  if (rawPort === undefined || rawPort === null || rawPort === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(rawPort), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const config = getConfig();
  const featureDefaults = config.features ?? {};
  const enableWeb = toBooleanFlag(process.env.ENABLE_WEB, featureDefaults.enableWeb ?? true);
  const enablePing = toBooleanFlag(process.env.ENABLE_PING, featureDefaults.enablePing ?? true);
  const enableDns = toBooleanFlag(process.env.ENABLE_DNS, featureDefaults.enableDns ?? true);
  const enableHttp = toBooleanFlag(process.env.ENABLE_HTTP, featureDefaults.enableHttp ?? true);

  const db = openDb();
  try {
    migrate();
  } catch (error) {
    console.error("[runtime] Failed to migrate database:", error);
    try {
      closeDb();
    } catch (closeError) {
      console.error("[runtime] Error while closing database after migration failure:", closeError);
    }
    process.exit(1);
    return;
  }

  const collectorPromises = [];
  const stopFns = [];

  let serverHandle = null;
  let shuttingDown = false;
  let resolveShutdown;
  const shutdownPromise = new Promise((resolve) => {
    resolveShutdown = resolve;
  });

  const initiateShutdown = async (reason) => {
    if (shuttingDown) {
      return shutdownPromise;
    }
    shuttingDown = true;
    console.log(`[runtime] Shutting down (${reason}).`);

    const stopResults = await Promise.allSettled(
      stopFns.map((fn) => {
        try {
          return fn();
        } catch (error) {
          return Promise.reject(error);
        }
      })
    );

    for (const result of stopResults) {
      if (result.status === "rejected") {
        console.error("[runtime] Error while stopping collector:", result.reason);
      }
    }

    await Promise.allSettled(collectorPromises);

    if (serverHandle && typeof serverHandle.close === "function") {
      try {
        await serverHandle.close();
      } catch (error) {
        console.error("[runtime] Error while closing server:", error);
      }
    }

    try {
      closeDb();
    } catch (error) {
      console.error("[runtime] Error while closing database:", error);
    }

    resolveShutdown();
    return shutdownPromise;
  };

  const signals = ["SIGINT", "SIGTERM"];
  const signalHandlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      console.log(`\n[runtime] Received ${signal}, initiating shutdown...`);
      initiateShutdown(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  function registerCollector(name, module, enabled) {
    if (!enabled) {
      return false;
    }

    if (!module || typeof module.runLoop !== "function") {
      console.warn(`[runtime] Collector '${name}' is missing runLoop(), skipping.`);
      return false;
    }

    try {
      const promise = module.runLoop();
      collectorPromises.push(
        promise.catch((error) => {
          console.error(`[runtime] Collector '${name}' exited with error:`, error);
          if (!shuttingDown) {
            initiateShutdown(`${name} error`);
          }
        })
      );
      if (typeof module.stop === "function") {
        stopFns.push(() => Promise.resolve(module.stop()));
      } else {
        stopFns.push(() => Promise.resolve());
      }
      return true;
    } catch (error) {
      console.error(`[runtime] Failed to start collector '${name}':`, error);
      initiateShutdown(`${name} start failure`);
      return false;
    }
  }

  const activeModules = {
    ping: registerCollector("ping", pingCollector, enablePing),
    dns: registerCollector("dns", dnsCollector, enableDns),
    http: registerCollector("http", httpCollector, enableHttp),
  };

  const disabledModules = Object.entries({
    web: enableWeb,
    ping: enablePing,
    dns: enableDns,
    http: enableHttp,
  })
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name);

  if (enableWeb) {
    try {
      const port = parsePort(process.env.PORT ?? config?.server?.port, 3030);
      const host = config?.server?.host ?? "127.0.0.1";
      serverHandle = await startServer({ host, port, db });
      console.log(`[runtime] Web server listening on http://${host}:${port}`);
    } catch (error) {
      console.error("[runtime] Failed to start web server:", error);
      await initiateShutdown("web error");
      process.exit(1);
      return;
    }
  }

  const startedModules = Object.entries(activeModules)
    .filter(([, started]) => started)
    .map(([name]) => name);

  console.log(
    `[runtime] Modules active: ${startedModules.length ? startedModules.join(", ") : "(none)"}`
  );
  if (disabledModules.length > 0) {
    console.log(`[runtime] Modules disabled via flags: ${disabledModules.join(", ")}`);
  }

  await shutdownPromise;

  for (const [signal, handler] of signalHandlers.entries()) {
    process.removeListener(signal, handler);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[runtime] Unexpected startup error:", error);
  process.exit(1);
});
