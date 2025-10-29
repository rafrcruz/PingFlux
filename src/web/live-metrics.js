import { EventEmitter } from "events";
import { createLogger } from "../runtime/logger.js";
import { buildLivePingMetrics } from "../services/pingService.js";
import { buildLiveDnsMetrics } from "../services/dnsService.js";
import { buildLiveHttpMetrics } from "../services/httpService.js";

const log = createLogger("live");
const DEFAULT_SCHEMA_VERSION = "1.0.0";
const DEFAULT_INTERVAL_MS = 2000;

function resolveInterval(config) {
  const envValue = process.env.LIVE_PUSH_INTERVAL_MS;
  const fromConfig = config?.livePushIntervalMs ?? config?.live?.intervalMs;
  const raw = envValue ?? fromConfig ?? DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 500) {
    return parsed;
  }
  return DEFAULT_INTERVAL_MS;
}

function resolveUseWindows(config) {
  const envValue = process.env.LIVE_USE_WINDOWS;
  if (envValue !== undefined) {
    const normalized = String(envValue).trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
  }
  if (config?.live?.useWindows !== undefined) {
    return Boolean(config.live.useWindows);
  }
  if (config?.liveUseWindows !== undefined) {
    return Boolean(config.liveUseWindows);
  }
  return true;
}

function buildUnitsBlock() {
  return {
    rtt: "ms",
    loss: "pct",
    lookup: "ms",
    ttfb: "ms",
  };
}

class LiveMetricsBroadcaster extends EventEmitter {
  constructor({ config } = {}) {
    super();
    this.config = config ?? {};
    this.intervalMs = resolveInterval(this.config);
    this.useWindows = resolveUseWindows(this.config);
    this.clients = new Set();
    this.timer = null;
    this.sequence = 0;
    this.lastDispatchTs = 0;
    this.lastPayload = null;
  }

  startLoop() {
    if (this.timer) {
      return;
    }
    const run = async () => {
      this.timer = null;
      try {
        await this.broadcast();
      } catch (error) {
        log.error("Broadcast failure", error);
      } finally {
        this.scheduleNext();
      }
    };
    this.timer = setTimeout(run, this.intervalMs);
    this.timer.unref?.();
  }

  scheduleNext() {
    if (this.clients.size === 0) {
      return;
    }
    if (!this.timer) {
      this.startLoop();
    }
  }

  stopLoop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  buildPayload() {
    const now = Date.now();
    const heartbeatSeq = ++this.sequence;
    const pingMetrics = buildLivePingMetrics({ now, useWindows: this.useWindows });
    const dnsMetrics = buildLiveDnsMetrics({ now });
    const httpMetrics = buildLiveHttpMetrics({ now });

    const payload = {
      schema: DEFAULT_SCHEMA_VERSION,
      ts: now,
      heartbeat: {
        seq: heartbeatSeq,
        ts: now,
      },
      units: buildUnitsBlock(),
      meta: {
        interval_ms: this.intervalMs,
        use_windows: this.useWindows,
      },
      ping: pingMetrics,
      dns: dnsMetrics,
      http: httpMetrics,
    };

    this.lastDispatchTs = now;
    this.lastPayload = payload;

    return payload;
  }

  async broadcast() {
    if (this.clients.size === 0) {
      return;
    }
    const payload = this.buildPayload();
    const serialized = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(serialized);
      } catch (error) {
        log.warn("Failed to push payload to client", error);
      }
    }
    this.emit("broadcast", payload);
  }

  pushImmediate(res) {
    const payload = this.lastPayload ?? this.buildPayload();
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  addClient(req, res) {
    this.clients.add(res);
    const onClose = () => {
      this.clients.delete(res);
      this.emit("client:closed", this.clients.size);
      if (this.clients.size === 0) {
        this.stopLoop();
      }
    };
    res.on("close", onClose);
    res.on("error", onClose);
    this.emit("client:added", this.clients.size);
    this.pushImmediate(res);
    this.scheduleNext();
  }

  handleRequest(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.addClient(req, res);
  }

  getStatus() {
    return {
      interval_ms: this.intervalMs,
      subscribers: this.clients.size,
      last_dispatch_ts: this.lastDispatchTs,
    };
  }

  close() {
    this.stopLoop();
    for (const res of this.clients) {
      try {
        res.end();
      } catch (error) {
        log.warn("Error closing SSE client", error);
      }
    }
    this.clients.clear();
  }
}

export function createLiveMetricsBroadcaster({ config } = {}) {
  return new LiveMetricsBroadcaster({ config });
}
