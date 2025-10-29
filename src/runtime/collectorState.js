const states = new Map();

export function markCollectorHeartbeat(name, { ok = true, error = null } = {}) {
  if (!name) {
    return;
  }
  const now = Date.now();
  const entry = states.get(name) ?? {};
  states.set(name, {
    status: ok ? "up" : "down",
    lastHeartbeatTs: now,
    lastError: error ? String(error) : null,
    count: (entry.count ?? 0) + 1,
  });
}

export function getCollectorStates() {
  const result = {};
  for (const [name, value] of states.entries()) {
    result[name] = {
      status: value.status ?? "unknown",
      lastHeartbeatTs: value.lastHeartbeatTs ?? null,
      lastError: value.lastError ?? null,
      count: value.count ?? 0,
    };
  }
  return result;
}
