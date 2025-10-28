import { getConfig } from "./config/index.js";

const config = getConfig();

console.log("PingFlux ready: baseline OK");
console.log(`NODE_ENV: ${config.env}`);
console.log(`PORT: ${config.server.port}`);
console.log(`LOG_LEVEL: ${config.logging.level}`);
console.log(`DB_PATH: ${config.storage.dbPath}`);
