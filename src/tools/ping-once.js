import { getPingSettings, measureCycle } from "../collectors/ping.js";

async function main() {
  const settings = getPingSettings();
  const targets = settings.targets;

  if (!targets.length) {
    console.log("[ping:once] No targets configured. Nothing to do.");
    return;
  }

  const samples = await measureCycle(targets);
  const summary = new Map();

  for (const sample of samples) {
    const key = sample.target;
    const current = summary.get(key) || { total: 0, success: 0 };
    current.total += 1;
    current.success += sample.success ? 1 : 0;
    summary.set(key, current);
  }

  console.log(`[ping:once] Inserted ${samples.length} sample${samples.length === 1 ? "" : "s"}.`);
  for (const [target, stats] of summary.entries()) {
    const successText = `${stats.success}/${stats.total} succeeded`;
    console.log(`  - ${target}: ${successText}`);
  }
}

main().catch((error) => {
  console.error("[ping:once] Unexpected error:", error);
  process.exitCode = 1;
});
