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

function createRequestHandler(db) {
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
