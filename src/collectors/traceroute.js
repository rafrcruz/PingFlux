import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { openDb, migrate } from "../storage/db.js";

const DEFAULT_TARGET = "8.8.8.8";
const DEFAULT_MAX_HOPS = 30;
const DEFAULT_TIMEOUT_MS = 10000;

let envFileCache;
let migrationsEnsured = false;
let insertStatement;

function parseEnvFileOnce() {
  if (envFileCache) {
    return envFileCache;
  }

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    envFileCache = {};
    return envFileCache;
  }

  const entries = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
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

    const rawValue = rest.join("=");
    const normalized = rawValue.replace(/^['"]?(.*?)['"]?$/, "$1");
    entries[key] = normalized;
  }

  envFileCache = entries;
  return envFileCache;
}

function getEnvValue(name) {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    return process.env[name];
  }

  const fileValues = parseEnvFileOnce();
  if (fileValues[name] !== undefined && fileValues[name] !== "") {
    return fileValues[name];
  }

  return undefined;
}

function toPositiveInteger(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureDbReady() {
  if (!migrationsEnsured) {
    migrate();
    migrationsEnsured = true;
  }
}

function getInsertStatement(db) {
  if (insertStatement) {
    return insertStatement;
  }

  insertStatement = db.prepare(
    "INSERT INTO traceroute_run (ts, target, hops_json, success) VALUES (?, ?, ?, ?)"
  );
  return insertStatement;
}

function terminateChildProcess(child) {
  if (!child) {
    return;
  }

  const pid = child.pid;
  try {
    child.kill();
  } catch (error) {
    // Ignore errors while attempting to terminate the child process.
  }

  if (process.platform === "win32" && pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
      killer.stdout?.resume();
      killer.stderr?.resume();
      killer.unref?.();
    } catch (error) {
      // Ignore taskkill errors; best-effort cleanup.
    }
  }
}

function normalizeRttToken(token) {
  if (!token) {
    return null;
  }

  const trimmed = token.replace(/\s+/g, "").toLowerCase();
  if (trimmed === "*") {
    return null;
  }

  if (trimmed.startsWith("<") && trimmed.endsWith("ms")) {
    return 0.5;
  }

  const numeric = token.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!numeric) {
    return null;
  }

  const value = Number.parseFloat(numeric[1]);
  return Number.isFinite(value) ? value : null;
}

function parseHopLine(line) {
  if (!line) {
    return null;
  }

  const trimmed = line.trim();
  if (!/^\d+/.test(trimmed)) {
    return null;
  }

  const match = /^(\d+)\s+(.*)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const hopNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(hopNumber)) {
    return null;
  }

  const rest = match[2];
  const rtts = [];
  const rttPattern = /(<\s*\d+\s*ms|\d+(?:\.\d+)?\s*ms|\*)/gi;
  let rttMatch;
  let lastIndex = 0;

  while (rtts.length < 3 && (rttMatch = rttPattern.exec(rest))) {
    rtts.push(normalizeRttToken(rttMatch[0]));
    lastIndex = rttPattern.lastIndex;
  }

  const remainder = rest.slice(lastIndex).trim();

  let ip = null;
  const bracketMatch = remainder.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    ip = bracketMatch[1].trim() || null;
  }

  if (!ip) {
    const ipv4Match = remainder.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (ipv4Match) {
      ip = ipv4Match[1];
    }
  }

  if (!ip) {
    const ipv6Match = remainder.match(/([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,})/i);
    if (ipv6Match && ipv6Match[1].includes(":")) {
      ip = ipv6Match[1];
    }
  }

  return {
    hop: hopNumber,
    rtt1_ms: rtts[0] ?? null,
    rtt2_ms: rtts[1] ?? null,
    rtt3_ms: rtts[2] ?? null,
    ip: ip ?? null,
  };
}

function parseTracerouteOutput(output) {
  if (!output) {
    return [];
  }

  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const hops = [];
  for (const line of lines) {
    const hop = parseHopLine(line);
    if (hop) {
      hops.push(hop);
    }
  }

  return hops;
}

function buildTracerouteArgs(target, maxHops, timeoutMs) {
  const hopLimit = Math.max(Math.min(maxHops, 255), 1);
  if (process.platform === "win32") {
    const args = ["-d", "-h", String(hopLimit)];
    const perHopTimeout = Math.max(Math.floor(timeoutMs / Math.max(hopLimit, 1)), 500);
    args.push("-w", String(perHopTimeout));
    args.push(target);
    return { command: "tracert", args };
  }

  const secondsTimeout = Math.max(Math.floor(timeoutMs / 1000), 1);
  const args = ["-n", "-m", String(hopLimit), "-w", String(secondsTimeout), target];
  return { command: "traceroute", args };
}

function executeTraceroute(target, { maxHops, timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    const { command, args } = buildTracerouteArgs(target, maxHops, timeoutMs);
    let child;

    try {
      child = spawn(command, args);
    } catch (error) {
      resolve({ success: false, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
    }, Math.max(timeoutMs, 1000));

    let abortListener = null;
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        terminateChildProcess(child);
      } else {
        abortListener = () => {
          aborted = true;
          terminateChildProcess(child);
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    child.on("error", (error) => {
      cleanup();
      resolve({ success: false, stdout, stderr, error, timedOut, aborted });
    });

    child.on("close", (code) => {
      cleanup();
      const success = !timedOut && !aborted && code === 0;
      resolve({ success, stdout, stderr, timedOut, aborted, exitCode: code });
    });
  });
}

export async function runTraceroute(
  rawTarget,
  { maxHops: requestedMaxHops, timeoutMs: requestedTimeoutMs, signal } = {}
) {
  const envDefaultTarget = String(getEnvValue("TRACEROUTE_DEFAULT_TARGET") ?? "").trim();
  const defaultTarget = envDefaultTarget || DEFAULT_TARGET;
  const target = String(rawTarget ?? "").trim() || defaultTarget;

  const envMaxHops = toPositiveInteger(getEnvValue("TRACEROUTE_MAX_HOPS"), DEFAULT_MAX_HOPS);
  const envTimeoutMs = toPositiveInteger(getEnvValue("TRACEROUTE_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);

  const effectiveMaxHops = Math.max(
    1,
    Math.min(envMaxHops, toPositiveInteger(requestedMaxHops, envMaxHops))
  );
  const effectiveTimeout = Math.max(
    1000,
    toPositiveInteger(requestedTimeoutMs, envTimeoutMs)
  );

  const ts = Date.now();
  let hops = [];
  let success = 0;

  try {
    const execution = await executeTraceroute(target, {
      maxHops: effectiveMaxHops,
      timeoutMs: effectiveTimeout,
      signal,
    });

    const combinedOutput = [execution.stdout, execution.stderr]
      .filter(Boolean)
      .join("\n");
    hops = parseTracerouteOutput(combinedOutput);
    success = execution.success ? 1 : 0;
  } catch (error) {
    success = 0;
    hops = [];
  }

  ensureDbReady();
  const db = openDb();
  const stmt = getInsertStatement(db);
  const info = stmt.run(ts, target, JSON.stringify(hops), success);
  const id = Number(info.lastInsertRowid);

  return { id, ts, target, success, hops };
}
