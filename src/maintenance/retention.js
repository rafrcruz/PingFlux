import { openDb, migrate } from "../storage/db.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveSettings() {
  const retentionRawDays = parsePositiveInteger(process.env.RETENTION_RAW_DAYS, 30);
  const retentionWindowsDays = parsePositiveInteger(process.env.RETENTION_WINDOWS_DAYS, 365);
  const maxRowsPerRun = parsePositiveInteger(process.env.MAINTENANCE_MAX_ROWS_PER_RUN, 0);

  return {
    retentionRawDays,
    retentionWindowsDays,
    maxRowsPerRun: maxRowsPerRun > 0 ? maxRowsPerRun : undefined,
  };
}

function buildDeleteStatement(db, tableName, columnName, hasLimit) {
  if (hasLimit) {
    return db.prepare(`
      DELETE FROM ${tableName}
      WHERE rowid IN (
        SELECT rowid FROM ${tableName}
        WHERE ${columnName} < ?
        ORDER BY ${columnName} ASC
        LIMIT ?
      )
    `);
  }

  return db.prepare(`DELETE FROM ${tableName} WHERE ${columnName} < ?`);
}

export function runRetention({ nowEpochMs } = {}) {
  const now = Number.isFinite(nowEpochMs) ? Number(nowEpochMs) : Date.now();
  const { retentionRawDays, retentionWindowsDays, maxRowsPerRun } = resolveSettings();
  const rawCutoffTs = now - retentionRawDays * MS_PER_DAY;
  const windowCutoffTs = now - retentionWindowsDays * MS_PER_DAY;

  migrate();
  const db = openDb();

  const tables = [
    { name: "ping_sample", column: "ts", cutoff: rawCutoffTs },
    { name: "dns_sample", column: "ts", cutoff: rawCutoffTs },
    { name: "http_sample", column: "ts", cutoff: rawCutoffTs },
    { name: "ping_window_1m", column: "ts_min", cutoff: windowCutoffTs },
  ];

  const deletedRows = {};

  const runDeletion = db.transaction(() => {
    for (const table of tables) {
      const hasLimit = maxRowsPerRun !== undefined;
      const stmt = buildDeleteStatement(db, table.name, table.column, hasLimit);
      const params = hasLimit ? [table.cutoff, maxRowsPerRun] : [table.cutoff];
      const result = stmt.run(...params);
      deletedRows[table.name] = result?.changes ? Number(result.changes) : 0;
    }
  });

  runDeletion();

  const totalDeleted = Object.values(deletedRows).reduce((sum, value) => sum + value, 0);
  let vacuumExecuted = false;

  if (totalDeleted > 0) {
    db.exec("VACUUM");
    vacuumExecuted = true;
  }

  return {
    nowEpochMs: now,
    settings: {
      retentionRawDays,
      retentionWindowsDays,
      maxRowsPerRun: maxRowsPerRun ?? null,
    },
    cutoffs: {
      rawDataTs: rawCutoffTs,
      windowedTs: windowCutoffTs,
    },
    deletedRows,
    vacuumExecuted,
  };
}
