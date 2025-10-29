import { getConfig } from "../config/index.js";
import { openDb, migrate, closeDb } from "../storage/db.js";
import * as pingCollector from "../collectors/ping.js";
import * as dnsCollector from "../collectors/dns.js";
import * as httpCollector from "../collectors/http.js";
import { startServer } from "../web/server.js";
import {
  getShutdownSignal,
  registerOnShutdown,
  initSignalHandlers,
  waitForShutdown,
  initiateShutdown,
} from "./shutdown.js";
import { createLogger } from "./logger.js";
import { isEnabled } from "./features.js";

function parsePort(rawPort, fallback) {
  if (rawPort === undefined || rawPort === null || rawPort === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(rawPort), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const config = getConfig();
  const log = createLogger("runtime");
  const enableWeb = isEnabled("WEB");
  const enablePing = isEnabled("PING");
  const enableDns = isEnabled("DNS");
  const enableHttp = isEnabled("HTTP");

  const shutdownSignal = getShutdownSignal();

  const db = openDb();
  try {
    const result = migrate();
    if (result?.applied?.length) {
      log.info(`Applied migrations: ${result.applied.join(", ")}`);
    } else {
      log.debug("Database already up-to-date");
    }
  } catch (error) {
    log.error("Failed to migrate database", error);
    try {
      closeDb();
    } catch (closeError) {
      log.error("Error while closing database after migration failure", closeError);
    }
    process.exit(1);
    return;
  }

  registerOnShutdown(() => {
    try {
      closeDb();
    } catch (error) {
      log.warn("Error while closing database", error);
    }
  });

  const collectorPromises = [];

  const startCollector = (name, module, enabled) => {
    if (!enabled) {
      return false;
    }

    if (!module || typeof module.runLoop !== "function") {
      log.warn(`Collector '${name}' is missing runLoop(), skipping.`);
      return false;
    }

    try {
      const loopPromise = Promise.resolve(module.runLoop({ signal: shutdownSignal }));
      collectorPromises.push(loopPromise);
      loopPromise.catch((error) => {
        if (!shutdownSignal.aborted) {
          log.error(`Collector '${name}' exited with error`, error);
          initiateShutdown(`${name} error`).catch(() => {});
        }
      });

      if (typeof module.stop === "function") {
        registerOnShutdown(async () => {
          try {
            await module.stop();
          } catch (error) {
            log.warn(`Error while stopping collector '${name}'`, error);
          }
        });
      }

      return true;
    } catch (error) {
      log.error(`Failed to start collector '${name}'`, error);
      initiateShutdown(`${name} start failure`).catch(() => {});
      return false;
    }
  };

  const activeModules = {
    ping: startCollector("ping", pingCollector, enablePing),
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
          log.warn("Error while closing server", error);
        }
      });
      log.info(`Web server listening on http://${host}:${port}`);
    } catch (error) {
      log.error("Failed to start web server", error);
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

  log.info(`Modules active: ${startedModules.length ? startedModules.join(", ") : "(none)"}`);
  if (disabledModules.length > 0) {
    log.info(`Modules disabled via flags: ${disabledModules.join(", ")}`);
  }

  registerOnShutdown(() => {
    log.info("Shutdown complete.");
  });

  initSignalHandlers({ gracefulMs: 2000, forceMs: 5000 });

  log.info("Runtime initialized. Awaiting shutdown signal...");

  await waitForShutdown();

  process.exit(0);
}

main().catch((error) => {
  const log = createLogger("runtime");
  log.error("Unexpected startup error", error);
  process.exit(1);
});
