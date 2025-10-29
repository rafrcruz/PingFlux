import { getDbPath, getDbFileInfo, migrate, closeDb } from "../src/storage/db.js";
import { getConfig } from "../src/config/index.js";
import { countSamplesByTarget } from "../src/data/pingRepo.js";
import { countSamplesByHostname } from "../src/data/dnsRepo.js";
import { countSamplesByUrl } from "../src/data/httpRepo.js";

async function main() {
  const config = getConfig();
  console.log("PingFlux diagnostics");
  console.log("Node version:", process.version);
  console.log("DB path:", getDbPath());

  const dbInfo = getDbFileInfo();
  console.log("DB exists:", dbInfo.exists);
  if (dbInfo.exists) {
    const sizeMb = (dbInfo.sizeBytes / (1024 * 1024)).toFixed(3);
    console.log("DB size (MB):", sizeMb);
  }

  migrate();
  const counts = {
    pingTargets: countSamplesByTarget(),
    dnsHostnames: countSamplesByHostname(),
    httpUrls: countSamplesByUrl(),
  };

  const flags = config.features ?? {};
  console.log("Active modules:", {
    enableWeb: flags.enableWeb,
    enablePing: flags.enablePing,
    enableDns: flags.enableDns,
    enableHttp: flags.enableHttp,
  });

  console.log("Ping samples by target:");
  for (const row of counts.pingTargets) {
    console.log(`  ${row.target}: ${row.count}`);
  }

  console.log("DNS samples by hostname:");
  for (const row of counts.dnsHostnames) {
    console.log(`  ${row.hostname}: ${row.count}`);
  }

  console.log("HTTP samples by URL:");
  for (const row of counts.httpUrls) {
    console.log(`  ${row.url}: ${row.count}`);
  }

  closeDb();
}

main().catch((error) => {
  console.error("Diagnostics failed:", error);
  process.exit(1);
});
