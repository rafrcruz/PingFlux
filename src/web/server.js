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

export async function startServer({ host, port, db }) {
  const parsedPort = Number.parseInt(String(port ?? 3030), 10);
  const listenPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3030;
  const providedHost = typeof host === "string" ? host.trim() : "";
  const listenHost = providedHost === "127.0.0.1" ? "127.0.0.1" : "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler(db));

    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      resolve({
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                resolveClose();
              }
            });
          }),
        server,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);
  });
}
