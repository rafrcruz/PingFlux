const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

let globalLevel;

function resolveLevel() {
  if (globalLevel !== undefined) {
    return globalLevel;
  }

  const raw = process.env.LOG_LEVEL ? String(process.env.LOG_LEVEL).trim().toLowerCase() : "info";
  if (raw in LEVELS) {
    globalLevel = LEVELS[raw];
    return globalLevel;
  }
  globalLevel = LEVELS.info;
  return globalLevel;
}

function formatArgs(prefix, args) {
  if (!prefix) {
    return args;
  }
  if (!Array.isArray(args)) {
    return [prefix, args];
  }
  if (args.length === 0) {
    return [prefix];
  }
  const [first, ...rest] = args;
  if (typeof first === "string") {
    return [`${prefix} ${first}`, ...rest];
  }
  return [prefix, first, ...rest];
}

export function createLogger(prefix) {
  const tag = prefix ? `[${prefix}]` : "";
  const level = resolveLevel();

  const log = (severity, method, args) => {
    if (LEVELS[severity] < level) {
      return;
    }
    const formatted = formatArgs(tag, args);
    method.apply(console, formatted);
  };

  return {
    level,
    debug: (...args) => log("debug", console.debug ?? console.log, args),
    info: (...args) => log("info", console.info ?? console.log, args),
    warn: (...args) => log("warn", console.warn ?? console.log, args),
    error: (...args) => log("error", console.error ?? console.log, args),
  };
}

export function setLogLevel(levelName) {
  if (typeof levelName !== "string") {
    return;
  }
  const normalized = levelName.trim().toLowerCase();
  if (!(normalized in LEVELS)) {
    return;
  }
  globalLevel = LEVELS[normalized];
}

export function getLogLevel() {
  return resolveLevel();
}
