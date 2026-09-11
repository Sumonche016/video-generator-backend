import { chromium, type Browser, type Page } from "playwright";
import GoLogin from "gologin";
import { env } from "../../config/env.js";

// Extra Chrome flags handed to Orbita on top of the ones GoLogin builds
// itself (proxy, timezone, fingerprint masking, user-data-dir).
function buildOrbitaFlags(): string[] {
  const flags: string[] = [];

  // Chrome refuses to start as root ("Running as root without --no-sandbox is
  // not supported") and the deploy runs the backend as root. Making
  // chrome-sandbox setuid is not enough on Orbita 150+, so the flag is the
  // only way through. Linux-only: on a dev machine the browser runs as a
  // normal user and keeps its sandbox.
  if (process.platform === "linux") flags.push("--no-sandbox");

  if (env.FLOW_BROWSER_MODE === "headless") {
    // Chrome still needs a window size in headless or it reports a tiny
    // viewport, which changes what Flow renders and breaks the selectors.
    flags.push("--headless=new", "--window-size=1920,1080");
  } else if (env.FLOW_BROWSER_MODE === "offscreen") {
    // A real window, just moved far outside the visible desktop. Keeps the
    // full non-headless fingerprint while staying out of the way.
    flags.push("--window-position=-32000,-32000");
  }

  return flags;
}

// Starts the GoLogin antidetect profile (downloading/launching its Orbita
// browser locally via the official SDK) and returns the CDP websocket
// endpoint for it. The profile is expected to already be logged into
// Google, so Playwright just drives the existing session rather than
// performing any login itself.
async function startGoLoginProfile(
  profileId: string
): Promise<{ wsEndpoint: string; goLogin: GoLogin }> {
  if (!env.GOLOGIN_API_TOKEN) {
    throw new Error("GOLOGIN_API_TOKEN must be set to use the Flow video provider");
  }

  const goLogin = new GoLogin({
    token: env.GOLOGIN_API_TOKEN,
    profile_id: profileId,
    extra_params: buildOrbitaFlags(),
  });

  const { wsUrl } = await goLogin.start();
  return { wsEndpoint: wsUrl, goLogin };
}

// profileId selects which GoLogin profile (account) this run drives — the
// caller checks one out of the pool so concurrent runs never share a profile.
export async function getFlowBrowserPage(profileId: string): Promise<{
  browser: Browser;
  page: Page;
  close: () => Promise<void>;
}> {
  const { wsEndpoint, goLogin } = await startGoLoginProfile(profileId);
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Leaving a profile running after each generation piles up Orbita
  // processes and keeps the profile locked — browser.close() only tears
  // down Playwright's side of a CDP connection, so goLogin.stop() (which
  // actually terminates the Orbita process) is called too. Errors from
  // either are swallowed so one failing doesn't skip the other.
  const close = async () => {
    // Close the Flow tabs first. The profile launches with
    // --restore-last-session, so any tab left open is restored on the next
    // run — which is how a later run could start already sitting inside an
    // old project instead of on the Flow home page.
    for (const openPage of context.pages()) {
      await openPage.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    await goLogin.stop().catch(() => {});
  };

  return { browser, page, close };
}
