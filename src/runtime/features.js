import { getConfig } from "../config/index.js";

const featureMap = Object.freeze({
  PING: (config) => Boolean(config?.features?.enablePing ?? config?.enablePing ?? true),
  DNS: (config) => Boolean(config?.features?.enableDns ?? config?.enableDns ?? true),
  HTTP: (config) => Boolean(config?.features?.enableHttp ?? config?.enableHttp ?? true),
  WEB: (config) => Boolean(config?.features?.enableWeb ?? config?.enableWeb ?? true),
});

export function isEnabled(name) {
  const normalized = String(name ?? "")
    .trim()
    .toUpperCase();
  const config = getConfig();
  const resolver = featureMap[normalized];
  if (!resolver) {
    return false;
  }
  try {
    return Boolean(resolver(config));
  } catch (error) {
    return false;
  }
}
