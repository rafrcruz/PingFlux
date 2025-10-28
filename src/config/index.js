import fs from "fs";
import path from "path";

const DEFAULTS = Object.freeze({
  NODE_ENV: "development",
  PORT: "3030",
  LOG_LEVEL: "info",
  DB_PATH: "./data/netmon.sqlite",
});

const QUOTE_TRIM_PATTERN = /^['"]?(.*?)['"]?$/;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const entries = {};

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

    const rawValue = rest.join("=").trim();
    const value = rawValue.replace(QUOTE_TRIM_PATTERN, "$1");
    entries[key] = value;
  }

  return entries;
}

function resolveVar(name, envFromFile) {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") {
    return fromProcess;
  }

  const fromFile = envFromFile[name];
  if (fromFile !== undefined && fromFile !== "") {
    return fromFile;
  }

  return DEFAULTS[name];
}

function toInteger(value, fallback) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBooleanFlag(value) {
  if (value === undefined || value === null) {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function getConfig() {
  const envFilePath = path.resolve(process.cwd(), ".env");
  const fileVariables = parseEnvFile(envFilePath);

  const env = resolveVar("NODE_ENV", fileVariables);
  const port = toInteger(resolveVar("PORT", fileVariables), Number(DEFAULTS.PORT));
  const logLevel = resolveVar("LOG_LEVEL", fileVariables);
  const dbPath = resolveVar("DB_PATH", fileVariables);
  const allowDbReset = toBooleanFlag(resolveVar("ALLOW_DB_RESET", fileVariables));

  return {
    env,
    server: { port },
    logging: { level: logLevel },
    storage: { dbPath },
    flags: { allowDbReset },
  };
}
