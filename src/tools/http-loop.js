import { runLoop } from "../collectors/http.js";

runLoop().catch((error) => {
  console.error("[http:loop] Unexpected error:", error);
  process.exitCode = 1;
});
