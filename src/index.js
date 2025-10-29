import { getConfig } from "./config/index.js";
import * as logger from "./utils/logger.js";

const config = getConfig();

logger.info("core", "PingFlux ready: baseline OK");
logger.info("core", `NODE_ENV: ${config.env}`);
logger.info("core", `PORT: ${config.server.port}`);
logger.info("core", `LOG_LEVEL: ${config.logging.level}`);
logger.info("core", `DB_PATH: ${config.storage.dbPath}`);
