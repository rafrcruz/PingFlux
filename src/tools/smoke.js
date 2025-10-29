import { openDb, closeDb, healthCheck } from "../storage/db.js";

const DEFAULT_PORT = 3030;
const SMOKE_SSE_EVENTS = 2;
const SMOKE_SSE_TIMEOUT_MS = 5000;

function resolvePort(rawPort) {
  const parsed = Number.parseInt(rawPort, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PORT;
}

async function testSse(
  url,
  { requiredEvents = SMOKE_SSE_EVENTS, timeoutMs = SMOKE_SSE_TIMEOUT_MS } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  const decoder = new TextDecoder();
  let buffer = "";
  let events = 0;
  let success = false;

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SSE request failed with status ${response.status}`);
    }
    if (!response.body) {
      throw new Error("SSE response has no body");
    }

    reader = response.body.getReader();
    while (!success) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);
        if (rawEvent.length > 0) {
          events += 1;
          if (events >= requiredEvents) {
            success = true;
            break;
          }
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
      if (success) {
        break;
      }
    }
  } catch (error) {
    if (error.name === "AbortError" && success) {
      return true;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch (cancelError) {
        // Ignore cancellation errors when finishing the smoke test.
      }
    }
  }

  if (!success) {
    throw new Error(`SSE stream ended after ${events} event(s)`);
  }

  return true;
}

async function run() {
  const issues = [];
  let dbOpened = false;

  try {
    openDb();
    dbOpened = true;
    const dbStatus = healthCheck();
    if (!dbStatus.ok) {
      const message = dbStatus.error?.message ?? "Unknown database error";
      issues.push(`Database health check failed: ${message}`);
    }
  } catch (error) {
    issues.push(`Database initialization failed: ${error?.message ?? error}`);
  } finally {
    if (dbOpened) {
      try {
        closeDb();
      } catch (closeError) {
        issues.push(`Database close failed: ${closeError?.message ?? closeError}`);
      }
    }
  }

  const port = resolvePort(process.env.PORT ?? process.env.SMOKE_PORT ?? DEFAULT_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Health endpoint returned status ${response.status}`);
    }
    const payload = await response.json();
    const status = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
    if (status !== "ok") {
      issues.push(`Health endpoint reported status '${payload?.status ?? "unknown"}'`);
    }
  } catch (error) {
    issues.push(`Failed to verify /health endpoint: ${error?.message ?? error}`);
  }

  try {
    await testSse(`${baseUrl}/v1/live/metrics`, {
      requiredEvents: SMOKE_SSE_EVENTS,
      timeoutMs: SMOKE_SSE_TIMEOUT_MS,
    });
  } catch (error) {
    issues.push(`Live metrics SSE failed: ${error?.message ?? error}`);
  }

  if (issues.length === 0) {
    console.log("PingFlux smoke test OK");
    return;
  }

  console.error("PingFlux smoke test FAILED");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
}

run().catch((error) => {
  console.error("PingFlux smoke test encountered an unexpected error:", error);
  process.exit(1);
});
