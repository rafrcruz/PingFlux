import { getConfig } from "../config/index.js";

function printConfig() {
  const config = getConfig();
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

printConfig();
