import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { getConfig } from "../config/index.js";
import { createLogger } from "../runtime/logger.js";

const log = createLogger("db");

const DEFAULT_DB_PATH = "./data/netmon.sqlite";
let dbInstance;
let resolvedPath;
let pragmasApplied = false;
let migrationsCached;

function resolveDbPath() {
  if (resolvedPath) {
    return resolvedPath;
  }

  const config = getConfig();
  const rawPath =
    config?.storage?.dbPath && String(config.storage.dbPath).trim()
      ? config.storage.dbPath
      : config?.dbPath && String(config.dbPath).trim()
        ? config.dbPath
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

function applyPragmas(db) {
  if (pragmasApplied) {
    return;
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  pragmasApplied = true;
  log.info("Pragmas applied (WAL, synchronous=NORMAL, temp_store=MEMORY, foreign_keys=ON)");
}

export function openDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveDbPath();
  ensureDirectoryExists(dbPath);

  dbInstance = new Database(dbPath);
  applyPragmas(dbInstance);

  return dbInstance;
}

function migrationsDir() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(currentDir, "migrations");
}

function parseMigrationVersion(fileName) {
  const match = /^(\d+)_/.exec(fileName);
  if (!match) {
    throw new Error(`Invalid migration filename: ${fileName}`);
  }
  return Number.parseInt(match[1], 10);
}

function loadMigrationFiles() {
  if (migrationsCached) {
    return migrationsCached;
  }
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    migrationsCached = [];
    return migrationsCached;
  }
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => ({
      version: parseMigrationVersion(file),
      file,
      fullPath: path.join(dir, file),
      sql: fs.readFileSync(path.join(dir, file), "utf8"),
    }))
    .sort((a, b) => a.version - b.version);

  migrationsCached = files;
  return migrationsCached;
}

function ensureMetaTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '0')").run();
  }
}

function getCurrentVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    return 0;
  }
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setCurrentVersion(db, version) {
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
}

export function migrate() {
  const db = openDb();
  ensureMetaTable(db);

  const migrations = loadMigrationFiles();
  if (!migrations.length) {
    return { currentVersion: getCurrentVersion(db), applied: [] };
  }

  const appliedVersions = [];
  let currentVersion = getCurrentVersion(db);

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    log.info(`Applying migration ${migration.file} (v${migration.version})`);
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      setCurrentVersion(db, migration.version);
    });

    applyMigration();
    currentVersion = migration.version;
    appliedVersions.push(migration.version);
  }

  if (appliedVersions.length === 0) {
    log.debug("No migrations needed");
  } else {
    log.info(`Migrations complete. Current version=${currentVersion}`);
  }

  return { currentVersion, applied: appliedVersions };
}

export function runInTransaction(fn) {
  const db = openDb();
  if (typeof fn !== "function") {
    throw new Error("runInTransaction expects a function");
  }
  const wrapped = db.transaction(() => fn(db));
  return wrapped();
}

export function getMetaValue(key) {
  const db = openDb();
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(String(key));
  return row ? row.value : null;
}

export function setMetaValue(key, value) {
  const db = openDb();
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(key), value === undefined || value === null ? null : String(value));
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

export function getDbFileInfo() {
  try {
    const dbPath = resolveDbPath();
    const stats = fs.statSync(dbPath);
    return {
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtimeMs,
    };
  } catch (error) {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      error: error?.message,
    };
  }
}

export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (error) {
      log.warn("Error closing database", error);
    }
    dbInstance = undefined;
    pragmasApplied = false;
  }
}

process.on("exit", () => {
  closeDb();
});

export function getDbPath() {
  return resolveDbPath();
}
