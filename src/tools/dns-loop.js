import { runLoop } from "../collectors/dns.js";

runLoop().catch((error) => {
  console.error("[dns:loop] Unexpected error:", error);
  process.exitCode = 1;
});
