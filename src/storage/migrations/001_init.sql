CREATE TABLE IF NOT EXISTS ping_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  method TEXT NOT NULL,
  rtt_ms REAL,
  success INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_sample_ts ON ping_sample(ts);
CREATE INDEX IF NOT EXISTS idx_ping_sample_target_ts ON ping_sample(target, ts);

CREATE TABLE IF NOT EXISTS ping_window_1m (
  ts_min INTEGER NOT NULL,
  target TEXT NOT NULL,
  sent INTEGER NOT NULL,
  received INTEGER NOT NULL,
  loss_pct REAL NOT NULL,
  avg_ms REAL,
  p50_ms REAL,
  p95_ms REAL,
  stdev_ms REAL,
  PRIMARY KEY (ts_min, target)
);

CREATE TABLE IF NOT EXISTS dns_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  resolver TEXT,
  lookup_ms REAL,
  success INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dns_sample_ts ON dns_sample(ts);
CREATE INDEX IF NOT EXISTS idx_dns_sample_host_ts ON dns_sample(hostname, ts);

CREATE TABLE IF NOT EXISTS http_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  ttfb_ms REAL,
  total_ms REAL,
  bytes INTEGER,
  success INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_http_sample_ts ON http_sample(ts);
CREATE INDEX IF NOT EXISTS idx_http_sample_url_ts ON http_sample(url, ts);

CREATE TABLE IF NOT EXISTS traceroute_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  hops_json TEXT NOT NULL,
  success INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
