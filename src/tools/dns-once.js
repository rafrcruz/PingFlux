import { getDnsSettings, measureCycle } from "../collectors/dns.js";

async function main() {
  const settings = getDnsSettings();
  const hostnames = settings.hostnames;

  if (!hostnames.length) {
    console.log("[dns:once] No hostnames configured. Nothing to do.");
    return;
  }

  const samples = await measureCycle(hostnames);
  const summary = new Map();

  for (const sample of samples) {
    const key = sample.hostname;
    const current = summary.get(key) || { total: 0, success: 0 };
    current.total += 1;
    current.success += sample.success ? 1 : 0;
    summary.set(key, current);
  }

  console.log(`[dns:once] Inserted ${samples.length} sample${samples.length === 1 ? "" : "s"}.`);
  for (const [hostname, stats] of summary.entries()) {
    const successText = `${stats.success}/${stats.total} succeeded`;
    console.log(`  - ${hostname}: ${successText}`);
  }
}

main().catch((error) => {
  console.error("[dns:once] Unexpected error:", error);
  process.exitCode = 1;
});
