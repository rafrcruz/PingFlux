import { aggregateRange, aggregateSince } from "../collectors/ping-aggregate.js";

const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function printUsage() {
  console.log("Usage: node src/tools/ping-aggregate.js [--since <epochMs>]");
  console.log("Aggregates ping samples into 1-minute windows.");
}

function parseArguments(argv) {
  const result = {
    help: false,
    since: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }

    if (arg === "--since") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --since");
      }
      result.since = argv[i + 1];
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function formatIso(epochMs) {
  return new Date(epochMs).toISOString();
}

function pluralizeWindows(count) {
  return `window${count === 1 ? "" : "s"}`;
}

function runWithSince(sinceValue) {
  const now = Date.now();
  const processed = aggregateRange(sinceValue, now);

  console.log(
    `[ping:aggregate] Processed ${processed} ${pluralizeWindows(processed)} between ${formatIso(
      sinceValue,
    )} and ${formatIso(now)}.`,
  );
}

function runWithDefaultLookback() {
  const now = Date.now();
  const since = now - DEFAULT_LOOKBACK_MS;
  const processed = aggregateSince(since);
  const completedAt = Date.now();

  console.log(
    `[ping:aggregate] Processed ${processed} ${pluralizeWindows(processed)} between ${formatIso(
      since,
    )} and ${formatIso(completedAt)}.`,
  );
}

function main() {
  let parsed;

  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`[ping:aggregate] ${error.message}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printUsage();
    return;
  }

  try {
    if (parsed.since !== undefined) {
      const sinceValue = Number(parsed.since);
      if (!Number.isFinite(sinceValue)) {
        throw new Error(`Invalid --since value: ${parsed.since}`);
      }
      runWithSince(Math.floor(sinceValue));
      return;
    }

    runWithDefaultLookback();
  } catch (error) {
    console.error(`[ping:aggregate] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
