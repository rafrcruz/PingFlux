import { healthCheck, closeDb } from "../src/storage/db.js";

function main() {
  try {
    const result = healthCheck();
    if (result.ok) {
      console.log("DB OK");
      process.exitCode = 0;
    } else {
      const reason = result.error?.message ?? String(result.error);
      console.error(`DB health check failed: ${reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    const reason = error?.message ?? String(error);
    console.error(`DB health check failed: ${reason}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
