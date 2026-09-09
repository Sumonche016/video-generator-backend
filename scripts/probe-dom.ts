// Attaches to the running GoLogin browser and reports, per tab and per
// frame, where the media elements actually live — so "0 video source(s)"
// while a clip is plainly on screen can be explained instead of guessed at.
import "dotenv/config";
import { chromium } from "playwright";
import GoLogin from "gologin";
import { env } from "../src/config/env.js";
import { getFlowProfileIds } from "../src/providers/video/goLoginProfilePool.js";

async function main() {
  const goLogin = new GoLogin({
    token: env.GOLOGIN_API_TOKEN as string,
    profile_id: getFlowProfileIds()[0],
  });
  const { wsUrl } = await goLogin.start();
  const browser = await chromium.connectOverCDP(wsUrl);

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      console.log(`\n=== TAB: ${page.url()}`);
      for (const frame of page.frames()) {
        const counts = await frame
          .evaluate(() => {
            const deepCount = (selector: string) => {
              let n = 0;
              const walk = (root: Document | ShadowRoot) => {
                n += root.querySelectorAll(selector).length;
                root.querySelectorAll("*").forEach((el) => {
                  const sr = (el as HTMLElement).shadowRoot;
                  if (sr) walk(sr);
                });
              };
              walk(document);
              return n;
            };
            return {
              lightVideo: document.querySelectorAll("video").length,
              deepVideo: deepCount("video"),
              lightPct: document.querySelectorAll(".loading-percentage").length,
              deepPct: deepCount(".loading-percentage"),
              deepProgressBar: deepCount(".progress-bar"),
              shadowHosts: Array.from(document.querySelectorAll("*")).filter(
                (el) => (el as HTMLElement).shadowRoot
              ).length,
            };
          })
          .catch((e: Error) => ({ error: e.message.split("\n")[0] }));
        console.log(`  frame ${frame.url().slice(0, 70) || "(about:blank)"} ->`, JSON.stringify(counts));
      }

      // What Playwright's own (shadow-piercing) engine sees.
      console.log(
        "  playwright locator counts ->",
        JSON.stringify({
          video: await page.locator("video").count().catch(() => -1),
          loadingPct: await page.locator(".loading-percentage").count().catch(() => -1),
          progressBar: await page.locator(".progress-bar").count().catch(() => -1),
        })
      );
    }
  }

  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
