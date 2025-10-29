import { migrate, getDbPath } from "../src/storage/db.js";

try {
  const result = migrate();
  if (result.applied && result.applied.length > 0) {
    console.log(`Applied migrations: ${result.applied.join(", ")}`);
  } else {
    console.log("Database already up to date.");
  }
  console.log("Database path:", getDbPath());
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}
