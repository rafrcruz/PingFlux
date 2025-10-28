import fs from "fs";
import { getConfig } from "../src/config/index.js";
import { closeDb, getDbPath, migrate } from "../src/storage/db.js";

function isResetAllowed() {
  if (process.env.ALLOW_DB_RESET === "1") {
    return true;
  }

  try {
    const config = getConfig();
    return config?.flags?.allowDbReset === true;
  } catch (_error) {
    return false;
  }
}

function main() {
  if (!isResetAllowed()) {
    console.error("DB reset denied: set ALLOW_DB_RESET=1 (env or .env) to allow destructive reset.");
    process.exitCode = 1;
    return;
  }

  const dbPath = getDbPath();

  try {
    closeDb();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const recreatedPath = migrate();
    console.log(`DB reset at ${recreatedPath}`);
    process.exitCode = 0;
  } catch (error) {
    const reason = error?.message ?? String(error);
    console.error(`Failed to reset DB: ${reason}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
