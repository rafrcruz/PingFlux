import { getHttpSettings, measureCycle } from "../collectors/http.js";

async function main() {
  const settings = getHttpSettings();
  const urls = settings.urls;

  if (!urls.length) {
    console.log("[http:once] No URLs configured. Nothing to do.");
    return;
  }

  const samples = await measureCycle(urls);
  const summary = new Map();

  for (const sample of samples) {
    const key = sample.url;
    const current = summary.get(key) || { total: 0, success: 0 };
    current.total += 1;
    current.success += sample.success ? 1 : 0;
    summary.set(key, current);
  }

  console.log(`[http:once] Inserted ${samples.length} sample${samples.length === 1 ? "" : "s"}.`);
  for (const [url, stats] of summary.entries()) {
    const successText = `${stats.success}/${stats.total} succeeded`;
    console.log(`  - ${url}: ${successText}`);
  }
}

main().catch((error) => {
  console.error("[http:once] Unexpected error:", error);
  process.exitCode = 1;
});
