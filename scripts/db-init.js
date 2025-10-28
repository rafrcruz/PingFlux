import { migrate, closeDb } from "../src/storage/db.js";

function main() {
  try {
    const dbPath = migrate();
    console.log(`DB initialized at ${dbPath}`);
    process.exitCode = 0;
  } catch (error) {
    const reason = error?.message ?? String(error);
    console.error(`Failed to initialize DB: ${reason}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
