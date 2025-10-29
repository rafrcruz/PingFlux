import { getConfig } from "../config/index.js";
import { openDb, migrate, closeDb } from "../storage/db.js";
import * as pingCollector from "../collectors/ping.js";
import * as pingAggregator from "../collectors/ping-aggregate-loop.js";
import * as dnsCollector from "../collectors/dns.js";
import * as httpCollector from "../collectors/http.js";
import { startServer } from "../web/server.js";
import * as logger from "../utils/logger.js";
import {
  getShutdownSignal,
  registerOnShutdown,
  initSignalHandlers,
  waitForShutdown,
  initiateShutdown,
} from "./shutdown.js";

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

  const shutdownSignal = getShutdownSignal();

  const db = openDb();
  try {
    migrate();
  } catch (error) {
    logger.error("runtime", "Failed to migrate database", error);
    try {
      closeDb();
    } catch (closeError) {
      logger.error("runtime", "Error while closing database after migration failure", closeError);
    }
    process.exit(1);
    return;
  }

  registerOnShutdown(() => {
    try {
      closeDb();
    } catch (error) {
      logger.error("runtime", "Error while closing database", error);
    }
  });

  const collectorPromises = [];

  const startCollector = (name, module, enabled) => {
    if (!enabled) {
      return false;
    }

    if (!module || typeof module.runLoop !== "function") {
      logger.warn("runtime", `Collector '${name}' is missing runLoop(), skipping.`);
      return false;
    }

    try {
      const loopPromise = Promise.resolve(module.runLoop({ signal: shutdownSignal }));
      collectorPromises.push(loopPromise);
      loopPromise.catch((error) => {
        if (!shutdownSignal.aborted) {
          logger.error("runtime", `Collector '${name}' exited with error`, error);
          initiateShutdown(`${name} error`).catch(() => {});
        }
      });

      if (typeof module.stop === "function") {
        registerOnShutdown(async () => {
          try {
            await module.stop();
          } catch (error) {
            logger.error("runtime", `Error while stopping collector '${name}'`, error);
          }
        });
      }

      return true;
    } catch (error) {
      logger.error("runtime", `Failed to start collector '${name}'`, error);
      initiateShutdown(`${name} start failure`).catch(() => {});
      return false;
    }
  };

  const activeModules = {
    ping: startCollector("ping", pingCollector, enablePing),
    "ping-agg": startCollector("ping-agg", pingAggregator, enablePing),
    dns: startCollector("dns", dnsCollector, enableDns),
    http: startCollector("http", httpCollector, enableHttp),
  };

  if (collectorPromises.length > 0) {
    registerOnShutdown(async () => {
      await Promise.allSettled(collectorPromises);
    });
  }

  let serverHandle = null;
  if (enableWeb) {
    try {
      const port = parsePort(process.env.PORT ?? config?.server?.port, 3030);
      const host = config?.server?.host ?? "127.0.0.1";
      serverHandle = await startServer({
        host,
        port,
        db,
        signal: shutdownSignal,
        config,
      });
      registerOnShutdown(async () => {
        if (!serverHandle) {
          return;
        }
        try {
          await serverHandle.close();
        } catch (error) {
          logger.error("runtime", "Error while closing server", error);
        }
      });
      logger.info("runtime", `Web server listening on http://${host}:${port}`);
    } catch (error) {
      logger.error("runtime", "Failed to start web server", error);
      await initiateShutdown("web error");
      process.exit(1);
      return;
    }
  }

  const disabledModules = Object.entries({
    web: enableWeb,
    ping: enablePing,
    dns: enableDns,
    http: enableHttp,
  })
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name);

  const startedModules = Object.entries(activeModules)
    .filter(([, started]) => started)
    .map(([name]) => name);

  logger.info(
    "runtime",
    `Modules active: ${startedModules.length ? startedModules.join(", ") : "(none)"}`
  );
  if (disabledModules.length > 0) {
    logger.info("runtime", `Modules disabled via flags: ${disabledModules.join(", ")}`);
  }

  registerOnShutdown(() => {
    logger.info("runtime", "Shutdown complete.");
  });

  initSignalHandlers({ gracefulMs: 2000, forceMs: 5000 });

  logger.info("runtime", "Runtime initialized. Awaiting shutdown signal...");

  await waitForShutdown();

  process.exit(0);
}

main().catch((error) => {
  logger.error("runtime", "Unexpected startup error", error);
  process.exit(1);
});
