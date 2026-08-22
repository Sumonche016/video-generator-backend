import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";

async function main() {
  // Pull in any API keys saved from the Settings page before serving
  // requests, so a previous key change survives a server restart.
  await loadRuntimeConfig();

  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`video-generator backend listening on http://localhost:${env.PORT}`);
  });
}

main();
