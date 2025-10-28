import http from "http";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  const body = html ?? "";
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = text ?? "";
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

const RANGE_TO_DURATION_MS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function resolveRangeWindow(rawRange) {
  const normalized = typeof rawRange === "string" ? rawRange.trim().toLowerCase() : "";
  const rangeKey = RANGE_TO_DURATION_MS[normalized] ? normalized : "1h";
  const durationMs = RANGE_TO_DURATION_MS[rangeKey];
  const nowMs = Date.now();
  const fromMs = nowMs - durationMs;

  return { fromMs, toMs: nowMs };
}

function createRequestHandler(db) {
  const hasDb = db && typeof db.prepare === "function";
  const statements = hasDb
    ? {
        pingWindowAll: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? ORDER BY target ASC, ts_min ASC"
        ),
        pingWindowByTarget: db.prepare(
          "SELECT ts_min, target, sent, received, loss_pct, p50_ms, p95_ms, stdev_ms FROM ping_window_1m WHERE ts_min BETWEEN ? AND ? AND target = ? ORDER BY ts_min ASC"
        ),
        dnsSamplesAll: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, success FROM dns_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        dnsSamplesByHostname: db.prepare(
          "SELECT ts, hostname, resolver, lookup_ms, success FROM dns_sample WHERE ts BETWEEN ? AND ? AND hostname = ? ORDER BY ts ASC"
        ),
        httpSamplesAll: db.prepare(
          "SELECT ts, url, status, ttfb_ms, total_ms, bytes, success FROM http_sample WHERE ts BETWEEN ? AND ? ORDER BY ts ASC"
        ),
        httpSamplesByUrl: db.prepare(
          "SELECT ts, url, status, ttfb_ms, total_ms, bytes, success FROM http_sample WHERE ts BETWEEN ? AND ? AND url = ? ORDER BY ts ASC"
        ),
      }
    : null;

  return (req, res) => {
    const { method, url } = req;
    if (!method || !url) {
      sendText(res, 400, "Bad request");
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url, "http://127.0.0.1");
    } catch (error) {
      sendText(res, 400, "Invalid URL");
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/health") {
      try {
        if (db) {
          db.prepare("SELECT 1").get();
        }
        sendJson(res, 200, { status: "ok" });
      } catch (error) {
        sendJson(res, 500, { status: "error", message: error?.message ?? "Unknown" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/ping/window") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawTarget = parsedUrl.searchParams.get("target");
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";

      try {
        if (target) {
          const rows = statements.pingWindowByTarget.all(fromMs, toMs, target);
          sendJson(res, 200, rows);
        } else {
          const rows = statements.pingWindowAll.all(fromMs, toMs);
          const grouped = Object.create(null);
          for (const row of rows) {
            if (!grouped[row.target]) {
              grouped[row.target] = [];
            }
            grouped[row.target].push(row);
          }
          sendJson(res, 200, grouped);
        }
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/dns") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawHostname = parsedUrl.searchParams.get("hostname");
      const hostname = typeof rawHostname === "string" ? rawHostname.trim() : "";

      try {
        const baseRows = hostname
          ? statements.dnsSamplesByHostname.all(fromMs, toMs, hostname)
          : statements.dnsSamplesAll.all(fromMs, toMs);
        const mapped = baseRows.map((row) => ({
          ts: row.ts,
          hostname: row.hostname,
          resolver: row.resolver,
          lookup_ms: row.lookup_ms,
          success: row.success === 1,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/api/http") {
      if (!statements) {
        sendJson(res, 500, { error: "Database unavailable" });
        return;
      }

      const { fromMs, toMs } = resolveRangeWindow(parsedUrl.searchParams.get("range"));
      const rawUrlParam = parsedUrl.searchParams.get("url");
      const urlParam = typeof rawUrlParam === "string" ? rawUrlParam.trim() : "";

      try {
        const baseRows = urlParam
          ? statements.httpSamplesByUrl.all(fromMs, toMs, urlParam)
          : statements.httpSamplesAll.all(fromMs, toMs);
        const mapped = baseRows.map((row) => ({
          ts: row.ts,
          url: row.url,
          status: row.status,
          ttfb_ms: row.ttfb_ms,
          total_ms: row.total_ms,
          bytes: row.bytes,
          success: row.success === 1,
        }));
        sendJson(res, 200, mapped);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? "Query failed" });
      }
      return;
    }

    if (method === "GET" && parsedUrl.pathname === "/") {
      sendHtml(res, 200, "<!DOCTYPE html><html><body><h1>PingFlux UI online</h1></body></html>");
      return;
    }

    sendText(res, 404, "Not found");
  };
}

export async function startServer({ host, port, db, signal, closeTimeoutMs = 1500 }) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const listenPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const listenHost = providedHost === "127.0.0.1" ? "127.0.0.1" : "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler(db));
    const sockets = new Set();
    let closeRequested = false;
    let signalHandler = null;
    let exportedClose = null;
    let settled = false;

    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const onError = (error) => {
      server.removeListener("listening", onListening);
      finishReject(error);
    };

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });

    const onListening = () => {
      server.removeListener("error", onError);
      const close = () => {
        if (closeRequested) {
          return Promise.resolve();
        }
        closeRequested = true;

        return new Promise((resolveClose, rejectClose) => {
          let completed = false;

          const timeout = setTimeout(() => {
            if (completed) {
              return;
            }
            completed = true;
            for (const socket of sockets) {
              try {
                socket.destroy();
              } catch (error) {
                // Ignore socket destroy errors during forced shutdown.
              }
            }
            resolveClose();
          }, closeTimeoutMs);
          timeout.unref?.();

          server.close((err) => {
            if (completed) {
              return;
            }
            completed = true;
            clearTimeout(timeout);
            if (err) {
              rejectClose(err);
            } else {
              resolveClose();
            }
          });
        });
      };

      exportedClose = close;

      finishResolve({
        close,
        server,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);

    if (signal) {
      const handleAbort = () => {
        if (exportedClose) {
          exportedClose().catch(() => {});
        } else {
          closeRequested = true;
          server.close(() => {});
          finishReject(new Error("Server shutdown requested before start"));
        }
      };

      if (signal.aborted) {
        handleAbort();
      } else {
        signalHandler = handleAbort;
        signal.addEventListener("abort", signalHandler);
      }
    }

    server.once("close", () => {
      if (signal && signalHandler) {
        signal.removeEventListener("abort", signalHandler);
      }
    });
  });
}
