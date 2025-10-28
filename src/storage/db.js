import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getConfig } from "../config/index.js";

const DEFAULT_DB_PATH = "./data/netmon.sqlite";
let dbInstance;
let resolvedPath;

function resolveDbPath() {
  if (resolvedPath) {
    return resolvedPath;
  }

  const config = getConfig();
  const rawPath =
    config?.storage?.dbPath && String(config.storage.dbPath).trim()
      ? config.storage.dbPath
      : DEFAULT_DB_PATH;

  resolvedPath = path.resolve(process.cwd(), rawPath);
  return resolvedPath;
}

function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function openDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveDbPath();
  ensureDirectoryExists(dbPath);

  dbInstance = new Database(dbPath);
  dbInstance.pragma("busy_timeout = 5000");
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  return dbInstance;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS ping_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  method TEXT NOT NULL,
  rtt_ms REAL,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ping_sample_ts ON ping_sample(ts);
CREATE INDEX IF NOT EXISTS idx_ping_sample_target_ts ON ping_sample(target, ts);

CREATE TABLE IF NOT EXISTS ping_window_1m (
  ts_min INTEGER NOT NULL,
  target TEXT NOT NULL,
  sent INTEGER NOT NULL,
  received INTEGER NOT NULL,
  loss_pct REAL NOT NULL,
  p50_ms REAL,
  p95_ms REAL,
  stdev_ms REAL,
  PRIMARY KEY (ts_min, target)
);

CREATE TABLE IF NOT EXISTS dns_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  resolver TEXT,
  lookup_ms REAL,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dns_sample_ts ON dns_sample(ts);

CREATE TABLE IF NOT EXISTS http_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  ttfb_ms REAL,
  total_ms REAL,
  bytes INTEGER,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_sample_ts ON http_sample(ts);

CREATE TABLE IF NOT EXISTS traceroute_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  hops_json TEXT NOT NULL,
  success INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function migrate() {
  const db = openDb();
  db.exec("BEGIN");
  try {
    db.exec(MIGRATION_SQL);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return resolveDbPath();
}

export function healthCheck() {
  try {
    const db = openDb();
    db.prepare("SELECT 1").get();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

process.on("exit", () => {
  closeDb();
});

export function getDbPath() {
  return resolveDbPath();
}
