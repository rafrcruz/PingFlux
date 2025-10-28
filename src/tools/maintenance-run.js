import { runRetention } from "../maintenance/retention.js";

function main() {
  try {
    const summary = runRetention();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error("Maintenance run failed:");
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

main();
