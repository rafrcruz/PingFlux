import fs from "fs";
import path from "path";

const DEFAULTS = Object.freeze({
  NODE_ENV: "development",
  PORT: "3030",
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  DB_PATH: "./data/netmon.sqlite",
  ENABLE_WEB: "true",
  ENABLE_PING: "true",
  ENABLE_DNS: "true",
  ENABLE_HTTP: "true",
  PING_TARGETS: "3.174.59.117,8.8.8.8,1.1.1.1",
  PING_INTERVAL_S: "60",
  PING_TIMEOUT_MS: "3000",
  PING_METHOD: "auto",
  DNS_HOSTNAMES: "google.com",
  DNS_INTERVAL_S: "60",
  DNS_TIMEOUT_MS: "3000",
  HTTP_URLS: "https://example.com",
  HTTP_INTERVAL_S: "60",
  HTTP_TIMEOUT_MS: "5000",
  ALERT_P95_MS: "200",
  ALERT_LOSS_PCT: "1.0",
  ALERT_MIN_POINTS: "10",
  LIVE_PUSH_INTERVAL_MS: "2000",
  LIVE_USE_WINDOWS: "true",
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

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInteger(value, fallback) {
  const parsed = toInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function toStringList(value, fallbackList) {
  if (value === undefined || value === null) {
    return [...fallbackList];
  }

  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : [...fallbackList];
}

function toMethodPreference(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "icmp":
    case "tcp":
      return normalized;
    case "auto":
    default:
      return "auto";
  }
}

export function getConfig() {
  const envFilePath = path.resolve(process.cwd(), ".env");
  const fileVariables = parseEnvFile(envFilePath);

  const env = String(resolveVar("NODE_ENV", fileVariables) ?? "development").trim() || "development";
  const host = String(resolveVar("HOST", fileVariables) ?? DEFAULTS.HOST).trim() || DEFAULTS.HOST;
  const port = toPositiveInteger(resolveVar("PORT", fileVariables), Number(DEFAULTS.PORT));
  const logLevel = String(resolveVar("LOG_LEVEL", fileVariables) ?? DEFAULTS.LOG_LEVEL).trim() || DEFAULTS.LOG_LEVEL;
  const dbPath = String(resolveVar("DB_PATH", fileVariables) ?? DEFAULTS.DB_PATH).trim() || DEFAULTS.DB_PATH;

  const enableWeb = toBoolean(resolveVar("ENABLE_WEB", fileVariables), toBoolean(DEFAULTS.ENABLE_WEB, true));
  const enablePing = toBoolean(resolveVar("ENABLE_PING", fileVariables), toBoolean(DEFAULTS.ENABLE_PING, true));
  const enableDns = toBoolean(resolveVar("ENABLE_DNS", fileVariables), toBoolean(DEFAULTS.ENABLE_DNS, true));
  const enableHttp = toBoolean(resolveVar("ENABLE_HTTP", fileVariables), toBoolean(DEFAULTS.ENABLE_HTTP, true));

  const pingTargets = toStringList(resolveVar("PING_TARGETS", fileVariables), DEFAULTS.PING_TARGETS.split(","));
  const pingIntervalMs = toPositiveInteger(
    resolveVar("PING_INTERVAL_MS", fileVariables) ??
      Number(resolveVar("PING_INTERVAL_S", fileVariables) ?? DEFAULTS.PING_INTERVAL_S) * 1000,
    Number(DEFAULTS.PING_INTERVAL_S) * 1000
  );
  const pingTimeoutMs = toPositiveInteger(resolveVar("PING_TIMEOUT_MS", fileVariables), Number(DEFAULTS.PING_TIMEOUT_MS));
  const pingMethod = toMethodPreference(
    process.env.PING_METHOD ??
      process.env.PING_METHOD_PREFERENCE ??
      fileVariables.PING_METHOD ??
      fileVariables.PING_METHOD_PREFERENCE ??
      DEFAULTS.PING_METHOD
  );

  const dnsHostnames = toStringList(
    resolveVar("DNS_HOSTNAMES", fileVariables),
    DEFAULTS.DNS_HOSTNAMES.split(",")
  );
  const dnsIntervalS = toPositiveInteger(
    resolveVar("DNS_INTERVAL_S", fileVariables),
    Number(DEFAULTS.DNS_INTERVAL_S)
  );
  const dnsTimeoutMs = toPositiveInteger(resolveVar("DNS_TIMEOUT_MS", fileVariables), Number(DEFAULTS.DNS_TIMEOUT_MS));

  const httpUrls = toStringList(resolveVar("HTTP_URLS", fileVariables), DEFAULTS.HTTP_URLS.split(","));
  const httpIntervalS = toPositiveInteger(
    resolveVar("HTTP_INTERVAL_S", fileVariables),
    Number(DEFAULTS.HTTP_INTERVAL_S)
  );
  const httpTimeoutMs = toPositiveInteger(
    resolveVar("HTTP_TIMEOUT_MS", fileVariables),
    Number(DEFAULTS.HTTP_TIMEOUT_MS)
  );

  const livePushIntervalMs = toPositiveInteger(
    resolveVar("LIVE_PUSH_INTERVAL_MS", fileVariables),
    Number(DEFAULTS.LIVE_PUSH_INTERVAL_MS)
  );
  const liveUseWindows = toBoolean(
    resolveVar("LIVE_USE_WINDOWS", fileVariables),
    toBoolean(DEFAULTS.LIVE_USE_WINDOWS, true)
  );

  const alertP95Ms = toNumber(
    resolveVar("ALERT_P95_MS", fileVariables),
    Number(DEFAULTS.ALERT_P95_MS)
  );
  const alertLossPct = toNumber(
    resolveVar("ALERT_LOSS_PCT", fileVariables),
    Number(DEFAULTS.ALERT_LOSS_PCT)
  );
  const alertMinPoints = toPositiveInteger(
    resolveVar("ALERT_MIN_POINTS", fileVariables),
    Number(DEFAULTS.ALERT_MIN_POINTS)
  );

  return {
    env,
    server: { host, port },
    logging: { level: logLevel },
    storage: { dbPath },
    features: {
      enableWeb,
      enablePing,
      enableDns,
      enableHttp,
    },
    ping: {
      targets: pingTargets,
      intervalMs: pingIntervalMs,
      timeoutMs: pingTimeoutMs,
      methodPreference: pingMethod,
    },
    dns: {
      hostnames: dnsHostnames,
      intervalS: dnsIntervalS,
      timeoutMs: dnsTimeoutMs,
    },
    http: {
      urls: httpUrls,
      intervalS: httpIntervalS,
      timeoutMs: httpTimeoutMs,
    },
    liveMetrics: {
      pushIntervalMs: livePushIntervalMs,
      useWindows: liveUseWindows,
    },
    alerts: {
      p95Ms: alertP95Ms,
      lossPct: alertLossPct,
      minPoints: alertMinPoints,
    },
  };
}

