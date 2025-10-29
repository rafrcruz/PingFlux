import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseRttFromOutput } from "../src/collectors/ping.js";
import { parseTracerouteOutput } from "../src/collectors/traceroute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "../fixtures");

function readFixture(relativePath) {
  const filePath = path.join(fixturesDir, relativePath);
  return fs.readFileSync(filePath, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testPingParsers() {
  const enSuccess = parseRttFromOutput(readFixture("ping/en_success.txt"));
  assert(enSuccess === 12, `Expected RTT 12ms, got ${enSuccess}`);

  const ptSuccess = parseRttFromOutput(readFixture("ping/pt_success.txt"));
  assert(ptSuccess === 1 || ptSuccess === 0, `Expected RTT close to 0/1ms, got ${ptSuccess}`);

  const enTimeout = parseRttFromOutput(readFixture("ping/en_timeout.txt"));
  assert(enTimeout === null, "Expected null RTT for timeout");

  const ptTimeout = parseRttFromOutput(readFixture("ping/pt_timeout.txt"));
  assert(ptTimeout === null, "Expected null RTT for PT timeout");
}

function testTracerouteParsers() {
  const enHops = parseTracerouteOutput(readFixture("traceroute/en_success.txt"));
  assert(enHops.length === 3, `Expected 3 hops, got ${enHops.length}`);
  assert(enHops[0].ip === "192.168.0.1", "Expected first hop IP");
  assert(
    enHops[1].rtt1_ms === 10 || enHops[1].rtt1_ms === 9,
    "Expected second hop RTT around 10ms"
  );

  const ptHops = parseTracerouteOutput(readFixture("traceroute/pt_timeout.txt"));
  assert(ptHops.length === 3, `Expected 3 hops in PT sample, got ${ptHops.length}`);
  assert(
    ptHops[1].rtt1_ms === null && ptHops[1].rtt2_ms === null,
    "Expected timeout hop with null RTT"
  );
}

function main() {
  testPingParsers();
  testTracerouteParsers();
  console.log("Parsing fixtures validated successfully.");
}

main();
