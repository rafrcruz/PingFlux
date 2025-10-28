import { runLoop } from "../collectors/ping.js";

runLoop().catch((error) => {
  console.error("[ping:loop] Unexpected error:", error);
  process.exitCode = 1;
});
