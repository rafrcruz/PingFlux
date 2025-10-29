import { getConfig } from "../config/index.js";

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_MAP = {
  debug: { label: "DEBUG", method: "log" },
  info: { label: "INFO", method: "log" },
  warn: { label: "WARN", method: "warn" },
  error: { label: "ERROR", method: "error" },
};

let cachedThreshold;

function resolveThreshold() {
  if (cachedThreshold !== undefined) {
    return cachedThreshold;
  }

  let levelName = String(process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (!levelName) {
    try {
      const config = getConfig();
      levelName = String(config?.logging?.level ?? "").trim().toLowerCase();
    } catch (error) {
      levelName = "info";
    }
  }

  cachedThreshold = LEVEL_PRIORITY[levelName] ?? LEVEL_PRIORITY.info;
  return cachedThreshold;
}

function shouldLog(levelKey) {
  const threshold = resolveThreshold();
  const value = LEVEL_PRIORITY[levelKey] ?? LEVEL_PRIORITY.info;
  return value >= threshold;
}

function formatComponent(component) {
  if (!component) {
    return "APP";
  }
  return String(component).trim().toUpperCase() || "APP";
}

function formatMessage(message) {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error) {
    return message.stack || message.message || String(message);
  }
  return String(message);
}

function createEntry(levelKey, component, message) {
  const level = LEVEL_MAP[levelKey] ?? LEVEL_MAP.info;
  const timestamp = new Date().toISOString();
  const formattedComponent = formatComponent(component);
  const formattedMessage = formatMessage(message);
  return {
    level,
    timestamp,
    formattedComponent,
    formattedMessage,
  };
}

function emit(levelKey, component, message, ...rest) {
  if (!shouldLog(levelKey)) {
    return;
  }
  const entry = createEntry(levelKey, component, message);
  const method = console[levelKey === "warn" ? "warn" : levelKey === "error" ? "error" : "log"];
  const prefix = `[${entry.timestamp}][${entry.level.label}][${entry.formattedComponent}] ${entry.formattedMessage}`;
  if (typeof method === "function") {
    if (rest.length > 0) {
      method(prefix, ...rest);
    } else {
      method(prefix);
    }
  } else {
    console.log(prefix, ...rest);
  }
}

export function info(component, message, ...rest) {
  emit("info", component, message, ...rest);
}

export function debug(component, message, ...rest) {
  emit("debug", component, message, ...rest);
}

export function warn(component, message, ...rest) {
  emit("warn", component, message, ...rest);
}

export function error(component, message, ...rest) {
  emit("error", component, message, ...rest);
}
