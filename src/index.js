import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');

// Minimal .env loader to avoid external dependencies.
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rest.join('=').trim();
  }
}

const { NODE_ENV, PORT } = process.env;

console.log('PingFlux ready: baseline OK');
console.log(`NODE_ENV: ${NODE_ENV ?? '(not set)'}`);
console.log(`PORT: ${PORT ?? '(not set)'}`);
