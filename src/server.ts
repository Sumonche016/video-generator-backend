import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { loadPromptOverrides } from "./config/promptRegistry.js";

async function main() {
  // Pull in any API keys / prompt edits saved from the web app before
  // serving requests, so they survive a server restart.
  await Promise.all([loadRuntimeConfig(), loadPromptOverrides()]);

  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`video-generator backend listening on http://localhost:${env.PORT}`);
  });
}

main();
