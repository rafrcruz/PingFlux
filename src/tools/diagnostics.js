import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

import { getConfig } from "../config/index.js";
import { migrate, openDb, closeDb, getDbPath } from "../storage/db.js";

function readPackageJson() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const pkgPath = path.resolve(__dirname, "../../package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  return JSON.parse(raw);
}

function formatKeyValue(key, value) {
  const formattedValue = typeof value === "object" ? JSON.stringify(value) : String(value);
  console.log(`- ${key}: ${formattedValue}`);
}

function printHeading(title) {
  console.log(`\n=== ${title} ===`);
}

function printRuntimeInfo(pkg) {
  printHeading("Runtime");
  formatKeyValue("PingFlux versão", pkg.version ?? "desconhecida");
  formatKeyValue("Node.js", process.version);
  formatKeyValue("Sistema", `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`);
}

function printConfigSummary(config) {
  printHeading("Config carregada");
  formatKeyValue("NODE_ENV", config.env);
  formatKeyValue("Host", config.server?.host);
  formatKeyValue("Porta", config.server?.port);
  formatKeyValue("DB", config.storage?.dbPath);
  formatKeyValue("Coletores", {
    web: config.features?.enableWeb,
    ping: config.features?.enablePing,
    dns: config.features?.enableDns,
    http: config.features?.enableHttp,
  });
  formatKeyValue("Ping targets", config.ping?.targets?.join(", "));
  formatKeyValue("DNS hostnames", config.dns?.hostnames?.join(", "));
  formatKeyValue("HTTP urls", config.http?.urls?.join(", "));
}

function printEnvOverrides() {
  printHeading("Variáveis relevantes em process.env");
  const keys = [
    "NODE_ENV",
    "PORT",
    "LOG_LEVEL",
    "DB_PATH",
    "PING_TARGETS",
    "DNS_HOSTNAMES",
    "HTTP_URLS",
  ];
  keys.forEach((key) => {
    const value = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : "(não definido)";
    formatKeyValue(key, value);
  });
}

function printDbInfo() {
  printHeading("Banco de dados");
  const dbPath = getDbPath();
  formatKeyValue("Arquivo", dbPath);
  const exists = fs.existsSync(dbPath);
  formatKeyValue("Existe?", exists);

  if (!exists) {
    console.log("(Banco ainda não criado. Rode npm run db:init para gerar as tabelas.)");
    return;
  }

  const db = openDb();
  const tables = ["ping_sample", "ping_window_1m", "dns_sample", "http_sample", "traceroute_run"];

  tables.forEach((table) => {
    try {
      const row = db.prepare(`SELECT COUNT(1) as count FROM ${table}`).get();
      formatKeyValue(`Linhas em ${table}`, row?.count ?? 0);
    } catch (error) {
      formatKeyValue(`Linhas em ${table}`, `erro: ${error.message}`);
    }
  });
}

async function main() {
  try {
    const pkg = readPackageJson();
    const config = getConfig();

    await Promise.resolve(migrate());

    printRuntimeInfo(pkg);
    printConfigSummary(config);
    printEnvOverrides();
    printDbInfo();
  } catch (error) {
    console.error(`[diag] Falha: ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
