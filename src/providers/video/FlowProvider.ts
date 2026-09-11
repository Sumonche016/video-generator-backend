import { nanoid } from "nanoid";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { buffer as streamToBuffer } from "node:stream/consumers";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type {
  ClipStatusResult,
  GenerateClipParams,
  GenerateClipResult,
  VideoGenProvider,
} from "./VideoGenProvider.js";
import { getFlowBrowserPage } from "./goLoginClient.js";
import {
  acquireFlowProfile,
  describeFlowPool,
} from "./goLoginProfilePool.js";
import {
  abortableDelay,
  currentFlowRun,
  installFlowLogPrefix,
  throwIfAborted,
  withFlowRun,
} from "./flowRunContext.js";
import {
  createFlowLogBuffer,
  finishFlowLogBuffer,
  pruneFlowLogBuffers,
  readFlowLog,
  RESULT_RETENTION_MS,
  type FlowLogPage,
} from "./flowLogBuffer.js";
import {
  abortFlowRun,
  abortReasonOf,
  attachClose,
  finishFlowRun,
  markAcquired,
  registerFlowRun,
} from "./flowRunRegistry.js";

// Tag every log line a concurrent run produces with which run it came from.
installFlowLogPrefix();
import { clickWithAiFallback, fillWithAiFallback } from "./aiAssistedClick.js";
import { runFlowAgent } from "./flowAgent.js";
import { downloadAsset } from "../../storage/assetStorage.js";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const DEBUG_DIR = path.resolve("debug-screenshots");
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
// How long a finished result is kept so a failed persist can be retried. Owned
// by flowLogBuffer so the result and its log always age out together.

// undici (node's global fetch) reports every network failure as the same
// opaque "fetch failed" TypeError and puts the real reason — ENOTFOUND,
// ECONNREFUSED, socket hang up, a TLS error — on err.cause. Since the GoLogin
// SDK does all of its API and profile-download traffic through fetch, an
// unwrapped message says nothing about what actually broke, so walk the cause
// chain and append it.
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(`${current.message.split("\n")[0]}${code ? ` (${code})` : ""}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ") || String(err);
}

// A randomized pause between actions so the automation doesn't hammer the
// page instantly click-click-click (an obvious automation tell that's also
// exactly the kind of pattern Google's abuse detection looks for) — also
// gives Flow's own animations (popups opening, the "read more" overlay)
// time to finish before the next step looks for something to interact with.
// Widened from a tight 400-1100ms band to something closer to how long a
// person actually pauses between actions on a page.
function humanPause(minMs = 700, maxMs = 2200): Promise<void> {
  // abortableDelay rather than a bare setTimeout so a stop lands during the
  // pause instead of up to 2.2s later — these are scattered through the whole
  // run, so waiting them out would make every stop feel sluggish.
  return abortableDelay(minMs + Math.random() * (maxMs - minMs));
}

// Longer pause used right after a page navigation/load, standing in for the
// time a person spends actually looking at a page before doing anything —
// with the mouse actually wandering to a couple of random points instead of
// sitting frozen, since a cursor that never moves except to click is itself
// a tell.
async function readingPause(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const glances = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < glances; i++) {
    const x = Math.random() * viewport.width;
    const y = Math.random() * viewport.height;
    await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) });
    await humanPause(500, 1100);
  }
}

// Flow bounces a profile with a dead Google session to its sign-in screen,
// usually a beat after domcontentloaded rather than as part of the initial
// navigation, so sample for a moment rather than checking once.
const SIGNED_OUT_URL = /accounts\.google\.com|\/fx\/api\/auth\/signin|[?&]error=Callback/i;

// Fails a run immediately when the profile is not logged in.
//
// This is placed before any click helper on purpose: those fall back to asking
// an LLM where an element is, which on a sign-in page burns a few cents and
// ~10s to conclude the obvious. Failing at the navigation boundary structurally
// skips all of that, and the error names the profile so it is clear which one
// needs re-authenticating.
async function assertFlowSignedIn(page: Page, profileId: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = page.url();
    if (SIGNED_OUT_URL.test(url)) {
      throw new Error(
        `GoLogin profile ${profileId} is not signed in to Google (landed on ${url}). ` +
          `Open the profile in GoLogin, sign in to labs.google/fx, then retry.`
      );
    }
    // Clearly on Flow itself — nothing more to wait for.
    if (/\/fx\/tools\/flow|\/project\//.test(url)) return;
    await abortableDelay(500);
  }

  // Some sign-outs render in place rather than redirecting, so fall back to
  // looking for the button itself before letting the run continue.
  const signInButton = page.getByRole("button", { name: /sign in/i });
  if (await signInButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error(
      `GoLogin profile ${profileId} is not signed in to Google (sign-in screen at ${page.url()}). ` +
        `Open the profile in GoLogin, sign in to labs.google/fx, then retry.`
    );
  }
}

// When a click times out waiting for expected page content (e.g. the
// GoLogin profile has no working proxy and never actually reached Flow, or
// the page rendered in an unexpected locale), a bare Playwright timeout
// gives no clue what went wrong. Saving a screenshot + the page's URL/title
// at the moment of failure makes that diagnosable without re-running with
// a visible browser.
async function saveDebugScreenshot(page: Page, label: string): Promise<void> {
  const stamp = Date.now();
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${label}-${stamp}.png`);
    // Not fullPage: on this app a full-page capture waits on font loading
    // and times out after 30s, losing the dump entirely. A viewport shot
    // with animations disabled is enough to see the state we care about.
    await page.screenshot({ path: file, animations: "disabled", timeout: 10000 });
    console.error(
      `FlowProvider: saved debug screenshot to ${file} (page url=${page.url()}, title=${await page.title()})`
    );
  } catch (screenshotErr) {
    console.error("FlowProvider: failed to save debug screenshot", screenshotErr);
  }

  // A screenshot shows what the page looked like but not what to target —
  // dumping the real markup alongside it means a failed selector can be
  // fixed from actual DOM instead of guessing at structure from an image.
  try {
    const html = await page.content();
    const htmlFile = path.join(DEBUG_DIR, `${label}-${stamp}.html`);
    await writeFile(htmlFile, html, "utf8");
    console.error(`FlowProvider: saved page HTML to ${htmlFile}`);
  } catch (htmlErr) {
    console.error("FlowProvider: failed to save page HTML", htmlErr);
  }
}

// Is the attach-media panel actually open? "Upload media" alone is not a
// reliable signal — the unrelated top-right nav menu contains an item by
// that same name. These other labels ("Search assets", the Voices/Uploads
// tabs) exist only inside the attach panel itself.
async function attachPanelIsOpen(page: Page): Promise<boolean> {
  const signals = [
    page.getByPlaceholder(/search assets/i),
    page.getByText("Voices", { exact: true }),
    page.getByText("Uploads", { exact: true }),
  ];
  for (const signal of signals) {
    if (await signal.first().isVisible().catch(() => false)) return true;
  }
  return false;
}

// The "+" that opens the attach-media panel is an icon-only button with no
// accessible name, so neither a role/name lookup nor the accessibility tree
// can find it. Rather than trusting one guessed selector, try several
// position/structure-based strategies and — the part that actually matters —
// verify after each click that the panel really opened. A click that
// "succeeds" while doing nothing (or worse, hits the back arrow and leaves
// the project) is what caused every confusing downstream failure here.
async function openAttachMediaPanel(page: Page): Promise<boolean> {
  const projectUrl = page.url();

  const strategies: { label: string; locator: () => Locator }[] = [
    {
      // Nearest button *before* the "Agent" pill in DOM order — the "+" sits
      // immediately left of it in the prompt bar.
      label: 'button immediately preceding the "Agent" pill',
      locator: () => page.getByText("Agent", { exact: true }).locator("xpath=preceding::button[1]"),
    },
    {
      // Scoped to the prompt bar itself (the Slate editor's nearest ancestor
      // that contains buttons), so page-level chrome like the back arrow is
      // structurally excluded rather than merely sorted lower.
      label: "first button inside the prompt bar container",
      locator: () =>
        page
          .locator('.ProseMirror[contenteditable="true"], [data-slate-editor="true"]')
          .first()
          .locator("xpath=ancestor::*[.//button][1]")
          .locator("button")
          .first(),
    },
    {
      // Layout-based, nearest-first. Kept last: :left-of() matches every
      // button left of the anchor page-wide, so it's the loosest of the three.
      label: 'nearest button left of the "Agent" pill',
      locator: () => page.locator('button:left-of(:text("Agent"))').first(),
    },
  ];

  for (const strategy of strategies) {
    try {
      await strategy.locator().click({ timeout: 4000 });
    } catch {
      console.warn(`openAttachMediaPanel: strategy "${strategy.label}" did not resolve to a clickable element`);
      continue;
    }
    await humanPause(500, 1200);

    // A click that navigated us out of the project hit the wrong element
    // (e.g. the back arrow) — go back and try the next strategy rather than
    // continuing against a completely different page.
    if (page.url() !== projectUrl) {
      console.warn(
        `openAttachMediaPanel: strategy "${strategy.label}" navigated away (${page.url()}), returning to the project`
      );
      await page.goto(projectUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await humanPause();
      continue;
    }

    if (await attachPanelIsOpen(page)) {
      console.log(`openAttachMediaPanel: opened via "${strategy.label}"`);
      return true;
    }
    console.warn(`openAttachMediaPanel: strategy "${strategy.label}" clicked but the panel did not open`);
  }

  return false;
}

// Selectors below come from the panel's actual markup (captured via the
// debug HTML dump), not inference:
//   - the confirm button is `button.detail-add-to-prompt-btn`, labelled
//     " Add to prompt " for one item and "Add N items to prompt" for
//     several, and carries disabled="true" until uploads complete;
//   - each asset row exposes `aria-label="<filename>"` and a
//     `span.asset-title` holding the same name;
//   - while a file is still uploading its row renders a spinner plus a
//     `span.cdk-visually-hidden` reading "Uploading".
const ADD_TO_PROMPT_BUTTON = "button.detail-add-to-prompt-btn";

// An upload that hasn't landed yet leaves the confirm button disabled, so
// selecting assets immediately after setFiles() silently accomplishes
// nothing. Wait for every row's "Uploading" marker to clear first.
async function waitForUploadsToFinish(page: Page, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uploading = await page.getByText("Uploading", { exact: true }).count().catch(() => 0);
    if (uploading === 0) return;
    console.log(`FlowProvider: waiting for ${uploading} reference image upload(s) to finish`);
    await abortableDelay(3000);
  }
  // Rather than pressing on with uploads that never landed (and then
  // failing confusingly a few steps later), let the agent look at the page:
  // an upload can be stuck behind an error toast, a rejected file, or a
  // retry button.
  console.warn("FlowProvider: uploads still in progress after waiting — asking the agent");
  await saveDebugScreenshot(page, "uploads-stalled");
  await runFlowAgent({
    page,
    goal:
      "Get the reference image uploads in the attach-media panel to finish. A row still shows an " +
      "'Uploading' spinner. If an error is shown, dismiss it and retry the upload via 'Upload media'; " +
      "if it is simply slow, wait. Success is no row still uploading.",
    context:
      "Automating Google Flow. Reference images were uploaded into the attach-media panel but at " +
      "least one has been stuck uploading for two minutes. They must all finish before they can be " +
      "selected and attached to the prompt.",
    isDone: async () => (await page.getByText("Uploading", { exact: true }).count().catch(() => 0)) === 0,
    maxSteps: 8,
  });
}

// The panel supports multi-select (ctrl+click), and the confirm button then
// reads "Add N items to prompt" — so all the uploaded images can be
// attached with a single click rather than reopening the panel per image.
async function addUploadedImagesToPrompt(page: Page, tmpFiles: string[]): Promise<number> {
  await waitForUploadsToFinish(page);
  await humanPause();

  // Real row markup (from the panel's HTML dump):
  //   <cdk-virtual-scroll-viewport role="listbox" aria-multiselectable="true">
  //     <button role="option" class="asset-item" aria-selected="false">
  //       ... <span class="asset-title">MarcusThorne.png</span>
  // The clickable element is the button. Selection state shows up as
  // aria-selected="true" plus an .asset-item-multi-selected class once a
  // row is ctrl+clicked; .selection-bar-count only appears at 2+.
  const rowFor = (fileName: string): Locator =>
    page.locator("button.asset-item").filter({ hasText: fileName }).first();

  // Verified live against the panel: ctrl+click marks a row
  // aria-selected="true" AND adds .asset-item-multi-selected, so counting
  // rows is accurate for any number of selections. The "N items selected"
  // bar is NOT a general signal — it only renders at 2+, so relying on it
  // reported 0 whenever exactly one image was selected. Count the rows
  // first and keep the bar purely as a fallback.
  const selectionCount = async (): Promise<number> => {
    const rows = await page
      .locator('button.asset-item[aria-selected="true"], button.asset-item.asset-item-multi-selected')
      .count()
      .catch(() => 0);
    if (rows > 0) return rows;

    const text = await page
      .locator("span.selection-bar-count")
      .first()
      .textContent()
      .catch(() => null);
    const match = text?.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  };

  // Per-row toggling with per-click verification proved unworkable: because
  // ctrl+click *toggles*, a row that was already selected gets turned back
  // off, and reading the counter between clicks produced contradictory
  // values (one run logged "2 selected" after the first click, then "0"
  // after the second). Instead do one deterministic pass — plain-click the
  // first row to establish a clean single selection, ctrl+click the rest to
  // extend it — and judge only the final count. On a mismatch, clear the
  // selection and try the whole sequence once more from a known-empty state.
  const clearSelection = async (): Promise<void> => {
    const clearButton = page.locator('[aria-label="Clear selection"]').first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click().catch(() => {});
      await humanPause(400, 900);
    }
  };

  // The asset list is a cdk-virtual-scroll-viewport: only the rows near the
  // viewport exist in the DOM at all, so a row that is simply scrolled out
  // of range looks identical to a row that was never created. Scroll the
  // list and re-check before concluding an upload is missing.
  const findRow = async (fileName: string): Promise<Locator | null> => {
    const viewport = page.locator("cdk-virtual-scroll-viewport").first();
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = rowFor(fileName);
      if (await row.isVisible({ timeout: attempt === 0 ? 8000 : 2000 }).catch(() => false)) return row;
      if (!(await viewport.isVisible().catch(() => false))) break;
      await viewport.evaluate((el, step) => el.scrollBy(0, step), 300 * (attempt + 1)).catch(() => {});
      await humanPause(500, 900);
    }
    return null;
  };

  const selectAllRows = async (): Promise<number> => {
    for (const tmpFile of tmpFiles) {
      const fileName = path.basename(tmpFile);
      const row = await findRow(fileName);
      if (!row) {
        const present = await page
          .locator("span.asset-title")
          .allTextContents()
          .catch(() => [] as string[]);
        console.warn(
          `FlowProvider: uploaded asset row for ${fileName} never appeared in the panel. ` +
            `Rows currently listed: ${present.length ? present.join(" | ") : "(none)"}`
        );
        continue;
      }
      // ALWAYS ctrl+click, including the first row. Verified live against
      // the real panel: a PLAIN click on an asset row is not "select" at
      // all — it immediately attaches that single image and closes the
      // panel, so the next row's click then times out against a dead panel.
      // That is precisely why exactly one image ever got attached.
      await row.click({ modifiers: ["Control"] }).catch(() => {});
      await humanPause(600, 1200);
    }
    const count = await selectionCount();
    console.log(`FlowProvider: after selecting, panel reports ${count} item(s) selected`);
    return count;
  };

  // Gate: every uploaded image must actually be present in the asset list
  // before anything is selected or attached. Previously a row that never
  // showed up was just warned about and skipped, so the run carried on and
  // attached whatever subset it could find.
  const missing: string[] = [];
  for (const tmpFile of tmpFiles) {
    const fileName = path.basename(tmpFile);
    if (!(await findRow(fileName))) missing.push(fileName);
  }

  if (missing.length > 0) {
    const listed = await page.locator("span.asset-title").allTextContents().catch(() => [] as string[]);
    console.warn(
      `FlowProvider: ${missing.length} uploaded image(s) missing from the panel (${missing.join(", ")}) — asking the agent`
    );
    await runFlowAgent({
      page,
      goal:
        `Make all ${tmpFiles.length} uploaded reference images visible in the attach-media panel's ` +
        `asset list. These are missing from the list right now: ${missing.join(", ")}. ` +
        "The list is virtualised, so scrolling it may reveal them; the 'Search assets' box at the top " +
        "can also be used to find a file by name. If a file genuinely failed to upload, use the " +
        "'Upload media' button to retry it. Do NOT select rows or click 'Add to prompt' yet — the " +
        "only goal here is that every one of those files appears in the list.",
      context:
        `Automating Google Flow. ${tmpFiles.length} reference images were uploaded, but only these are ` +
        `currently listed: ${listed.length ? listed.join(", ") : "(none)"}. All of them must be ` +
        "available before they can be attached to the prompt.",
      isDone: async () => {
        for (const tmpFile of tmpFiles) {
          if (!(await findRow(path.basename(tmpFile)))) return false;
        }
        return true;
      },
      maxSteps: 10,
    });

    const stillMissing: string[] = [];
    for (const tmpFile of tmpFiles) {
      const fileName = path.basename(tmpFile);
      if (!(await findRow(fileName))) stillMissing.push(fileName);
    }
    if (stillMissing.length > 0) {
      console.warn(
        `FlowProvider: still missing ${stillMissing.join(", ")} after the agent — not attaching a partial set`
      );
      return 0;
    }
    console.log("FlowProvider: agent recovered the missing asset row(s)");
  }

  let selected = await selectAllRows();
  if (selected !== tmpFiles.length) {
    console.warn(
      `FlowProvider: expected ${tmpFiles.length} selected but panel reports ${selected} — clearing and retrying once`
    );
    await clearSelection();
    selected = await selectAllRows();
  }

  // Do NOT click "Add to prompt" with an incomplete selection. Clicking it
  // with 1 of 2 selected attaches the wrong set and closes the panel, which
  // is both wrong and much harder to recover from than fixing the selection
  // first. Hand the *selection* problem to the agent while the panel is
  // still open, and only continue once the counter matches.
  if (selected !== tmpFiles.length) {
    const fileNames = tmpFiles.map((f) => path.basename(f)).join(", ");
    console.warn(
      `FlowProvider: still ${selected}/${tmpFiles.length} selected — asking the agent to fix the selection before attaching`
    );
    await runFlowAgent({
      page,
      goal:
        `Make the attach-media panel show exactly ${tmpFiles.length} items selected — one for each of ` +
        `these uploaded images: ${fileNames}. Ctrl+click an asset row to add it to the selection ` +
        "(ctrl+click again would remove it, so only click rows that are not yet selected). The panel " +
        "marks each selected row with aria-selected=true and a highlighted style, and shows an 'N " +
        "items selected' bar once two or more are selected. IMPORTANT: a PLAIN click on a row does " +
        "not select it — it immediately attaches that single image and closes the panel — so always " +
        "ctrl+click. Do NOT click the 'Add to prompt' button; only fix the selection.",
      context:
        `Automating Google Flow. ${tmpFiles.length} reference images were uploaded and must ALL be ` +
        `attached to the prompt, but only ${selected} is currently selected. Attaching an incomplete ` +
        "set would generate a video with the wrong characters.",
      isDone: async () => (await selectionCount()) === tmpFiles.length,
      maxSteps: 10,
    });
    selected = await selectionCount();
    if (selected !== tmpFiles.length) {
      console.warn(
        `FlowProvider: agent could not complete the selection (${selected}/${tmpFiles.length}) — not attaching a partial set`
      );
      return 0;
    }
    console.log(`FlowProvider: agent completed the selection (${selected}/${tmpFiles.length})`);
  }

  if (selected === 0) return 0;

  // The button stays disabled until a valid selection exists, so wait for it
  // to become enabled rather than clicking into a no-op.
  const enabledButton = page.locator(`${ADD_TO_PROMPT_BUTTON}:not([disabled])`).first();
  try {
    await enabledButton.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    console.warn('FlowProvider: "Add to prompt" never became enabled, asking the AI');
    await clickWithAiFallback({
      page,
      goalDescription:
        "Click the button that attaches the selected uploaded image(s) to the prompt. It sits at the " +
        "bottom-right of the attach-media panel and reads 'Add to prompt' (or 'Add N items to prompt' " +
        "when several images are selected).",
      primaryLocator: () => page.locator(ADD_TO_PROMPT_BUTTON).first(),
      primaryTimeoutMs: 3000,
    });
    return selected;
  }

  const label = (await enabledButton.textContent().catch(() => ""))?.trim();
  // The label encodes the count ("Add 2 items to prompt"), so it is a final
  // cross-check that the panel agrees with us about what is being attached.
  const labelCount = Number(label?.match(/Add\s+(\d+)\s+items/i)?.[1] ?? 1);
  if (labelCount !== tmpFiles.length) {
    console.warn(
      `FlowProvider: button reads "${label}" but ${tmpFiles.length} image(s) were expected — not clicking a partial attach`
    );
    return 0;
  }

  await enabledButton.click();
  await humanPause(800, 1500);

  const attachedNow = await attachedThumbnailCount(page);
  console.log(
    `FlowProvider: clicked "${label}" — prompt bar now shows ${attachedNow} attachment thumbnail(s)`
  );
  // Report what actually landed on the prompt, not what we intended.
  return attachedNow > 0 ? Math.min(attachedNow, tmpFiles.length) : selected;
}

// Reading only the src *attribute* of <video> misses how the current app
// actually renders finished clips: the source can live on a child <source>,
// be assigned as a property (currentSrc) rather than an attribute, or the
// tile may show a poster <img> from the media CDN with no <video> at all
// until it's played. Collect all of those so "a new clip appeared" is
// actually detectable.
// Attachment chips render as images inside the prompt bar once assets are
// added to the prompt — the only direct evidence that attaching worked.
async function attachedThumbnailCount(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const editor = document.querySelector("flow-rich-text-editor");
      if (!editor) return 0;
      let node: HTMLElement | null = editor.parentElement;
      for (let depth = 0; depth < 5 && node; depth++) {
        const images = node.querySelectorAll("img");
        if (images.length > 0) return images.length;
        node = node.parentElement;
      }
      return 0;
    })
    .catch(() => 0);
}

// The DOM has proven unreliable for spotting the finished clip: the media
// tile lives behind shadow roots / nested Angular components, and queries
// that work in one build of Flow silently return nothing in the next. The
// network cannot hide, though — when the clip is ready the browser fetches
// it from the media CDN. Watching traffic for that URL is therefore the
// primary signal, with DOM polling kept only as a backup.
function watchForVideoUrls(page: Page): { urls: Set<string>; stop: () => void } {
  const urls = new Set<string>();

  // Two families of clip URL have been seen in the wild:
  //   https://flow-content.google/video/<uuid>?Expires=…      (media CDN)
  //   https://flow.google.com/asb/AB-nOUb…=mm,22,15           (same-origin)
  // Only the first was matched, so a run that got an /asb/ clip waited out
  // the full 300s while the finished <video> sat on screen. /asb/ is a
  // generic asset path though (reference-image thumbnails come from it
  // too), so an /asb/ URL counts only once a response proves it carried
  // video bytes.
  const isKnownVideoUrl = (url: string) =>
    /flow-content\.google\/video\/|getMediaUrlRedirect/i.test(url);
  const isAssetUrl = (url: string) => /flow\.google\.com\/asb\//i.test(url);

  const onRequest = (req: { url: () => string }) => {
    const url = req.url();
    if (isKnownVideoUrl(url)) urls.add(url);
  };
  const onResponse = (res: { url: () => string; headers: () => Record<string, string> }) => {
    const url = res.url();
    if (isKnownVideoUrl(url)) {
      urls.add(url);
      return;
    }
    if (!isAssetUrl(url)) return;
    const contentType = res.headers()["content-type"] ?? "";
    if (/^video\//i.test(contentType)) urls.add(url);
  };

  // Attach at the CONTEXT level, not the page: Flow can end up rendering the
  // finished clip in a different tab from the one we drove, and page-level
  // listeners then see literally nothing — which is exactly what happened
  // (0 network URLs while a <video preload="auto"> was on screen).
  const context = page.context();
  context.on("request", onRequest);
  context.on("response", onResponse);

  return {
    urls,
    stop: () => {
      context.off("request", onRequest);
      context.off("response", onResponse);
    },
  };
}

async function currentVideoSrcs(page: Page): Promise<string[]> {
  // Uses Playwright locators rather than page.evaluate(document.querySelectorAll)
  // ON PURPOSE: this app renders media tiles inside shadow roots, and raw DOM
  // queries do not pierce shadow DOM. An evaluate-based version reported
  // "0 video source(s)" for minutes while a finished clip was plainly on
  // screen. Playwright's selector engine pierces open shadow roots.
  //
  // Every FRAME of every tab is scanned, not just the top document: the
  // media grid has turned up in a child frame, and a page-level locator
  // does not cross an iframe boundary (readRenderProgress already had to
  // walk frames for exactly this reason). That combination — clip in a
  // frame, its src on an unrecognised /asb/ URL — is how a finished clip
  // could sit on screen while the wait logged "0 video source(s)".
  const found: string[] = [];

  const collect = async (frame: { locator: (sel: string) => any }) => {
    const videos = frame.locator("video");
    const count = await videos.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const video = videos.nth(i);
      const [src, currentSrc] = await Promise.all([
        video.getAttribute("src").catch(() => null),
        video.evaluate((el: Element) => (el as HTMLVideoElement).currentSrc).catch(() => null),
      ]);
      if (src) found.push(src);
      if (currentSrc) found.push(currentSrc);
    }

    const sources = frame.locator("video source[src]");
    const sourceCount = await sources.count().catch(() => 0);
    for (let i = 0; i < sourceCount; i++) {
      const src = await sources.nth(i).getAttribute("src").catch(() => null);
      if (src) found.push(src);
    }

    // Poster images that are clearly video media (not the uploaded reference
    // image thumbnails, which live under /image/).
    const posters = frame.locator('img[src*="/video/"], img[src*="getMediaUrlRedirect"]');
    const posterCount = await posters.count().catch(() => 0);
    for (let i = 0; i < posterCount; i++) {
      const src = await posters.nth(i).getAttribute("src").catch(() => null);
      if (src) found.push(src);
    }
  };

  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      await collect(frame);
    }
  }

  return [...new Set(found.filter(Boolean))];
}

// A FINISHED clip tile does not contain a <video> element at all until it
// is hovered: pre-hover it renders
//   <flow-video-tile><img alt="Generated video thumbnail" class="thumbnail"
//        src="https://flow-content.google/image/…">
// and only on hover does Angular swap in <video src="https://flow.google.com/asb/…">.
// That is why a completed render logged "0 video source(s) in the DOM" for
// the full 300s while the clip was plainly visible on screen. So the tile's
// thumbnail is the completion signal, and hovering it is how the actual
// video URL is obtained.
const VIDEO_TILE_THUMB = 'flow-video-tile img.thumbnail, img[alt*="video thumbnail" i]';

async function currentVideoThumbnails(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      const thumbs = frame.locator(VIDEO_TILE_THUMB);
      const count = await thumbs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const src = await thumbs.nth(i).getAttribute("src").catch(() => null);
        if (src) found.push(src);
      }
    }
  }
  return [...new Set(found)];
}

// Hovers a newly appeared clip tile so its <video> mounts, then reads the
// src off it. Returns null when no tile is new yet, or when hovering did
// not produce a video src (the next poll simply tries again).
async function resolveNewTileVideoSrc(
  page: Page,
  priorSrcs: Set<string>,
  priorThumbnails: Set<string>
): Promise<string | null> {
  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      const thumbs = frame.locator(VIDEO_TILE_THUMB);
      const count = await thumbs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const thumb = thumbs.nth(i);
        const src = await thumb.getAttribute("src").catch(() => null);
        if (!src || priorThumbnails.has(src)) continue;

        // Hover the tile, not the <img>: the img is replaced by the <video>
        // as a result of the hover, so a locator pointing at it goes stale.
        // Reached via the thumbnail's own ancestor rather than
        // locator("flow-video-tile").nth(i) — still-rendering tiles are
        // flow-video-tiles too, so those indexes do not line up.
        const tile = thumb.locator("xpath=ancestor::flow-video-tile[1]");
        await tile.hover({ timeout: 3000 }).catch(() => {});
        for (let attempt = 0; attempt < 6; attempt++) {
          const videoSrc = (await currentVideoSrcs(page)).find((v) => !priorSrcs.has(v));
          if (videoSrc) {
            console.log("FlowProvider: hovered the new clip tile and read its video src");
            return videoSrc;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        console.warn(
          "FlowProvider: a new clip tile appeared but hovering it did not mount a <video> yet"
        );
      }
    }
  }
  return null;
}

// While a clip renders, Flow shows the percentage in a
// `<div class="loading-percentage">12%</div>` on the tile. That element is
// part of an Angular component (the surrounding app is React), so it can
// live in a separate frame — check every frame, not just the main one.
// Returns null once no percentage is being displayed anywhere, which is the
// signal that rendering has finished.
async function readRenderProgress(page: Page): Promise<string | null> {
  // The generating tile renders <div class="loading-percentage">10%</div>.
  //
  // NOT the .progress-bar / --progress-percent value: that belongs to the
  // finished tile's playback scrubber, so reading it reported nonsense like
  // "3.8%" for a clip that was already complete.
  //
  // Scanned across every tab and every frame, because the media grid has
  // repeatedly turned out not to be in the page/frame we drove.
  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      const text = await frame
        .locator(".loading-percentage")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      if (text && /\d/.test(text)) return text.trim();
    }
  }
  return null;
}

// Waiting for a <video> element to merely exist is not a completion signal:
// Flow inserts the tile (with a <video> in it) the moment generation starts
// and shows a rising percentage on it while rendering. So an "attached"
// wait returns in seconds, mid-render, and whatever src is read then is a
// placeholder rather than the finished clip.
//
// Instead: snapshot which video srcs existed before submitting, then poll
// for a *new* src that persists while the on-tile percentage disappears.
// The prior-srcs snapshot also matters because projects get reused across
// runs now, so simply taking the first <video> on the page can pick up an
// older clip.
async function waitForNewRenderedVideo(
  page: Page,
  priorSrcs: Set<string>,
  timeoutMs: number,
  observedUrls: Set<string>,
  priorThumbnails: Set<string>
): Promise<string> {
  // Deliberately simple: poll for a video source that was not present
  // before we submitted, and return the moment one appears.
  //
  // The previous version tried to be clever — tracking the percentage
  // indicator, detecting "stalls", holding a new src for 45s to be sure,
  // and escalating to the LLM. All of that only added ways to be wrong:
  // this app often renders no percentage at all, so a healthy render looked
  // stalled and summoned the agent for nothing. A <video> src only shows up
  // once the clip is actually renderable, so its appearance is the signal.
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastProgress: string | null = null;
  let polls = 0;

  while (Date.now() < deadline) {
    // Network first — a video URL the browser actually fetched is proof the
    // clip exists, regardless of what the DOM will admit to.
    const fromNetwork = [...observedUrls].find((url) => !priorSrcs.has(url));
    if (fromNetwork) {
      console.log(
        `FlowProvider: clip URL seen on the network after ${Math.round((Date.now() - started) / 1000)}s`
      );
      return fromNetwork;
    }

    const fresh = (await currentVideoSrcs(page)).find((src) => !priorSrcs.has(src));
    if (fresh) {
      console.log(
        `FlowProvider: new clip available after ${Math.round((Date.now() - started) / 1000)}s`
      );
      return fresh;
    }

    // Nothing yet from the network or from a mounted <video> — check for a
    // finished tile that has not been hovered into having one.
    const fromTile = await resolveNewTileVideoSrc(page, priorSrcs, priorThumbnails);
    if (fromTile) {
      console.log(
        `FlowProvider: new clip tile resolved after ${Math.round((Date.now() - started) / 1000)}s`
      );
      return fromTile;
    }

    // Progress is logged when the app happens to expose it, purely so the
    // wait is observable — it is never used to decide anything.
    const progress = await readRenderProgress(page);
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      const done = /^100(\.0+)?\s*%$/.test(progress);
      console.log(
        `FlowProvider: render progress ${progress}${done ? " — complete, looking for the video URL" : ""}`
      );
    }

    // Heartbeat every ~15s so a long wait is never a silent black box.
    polls++;
    if (polls % 5 === 0) {
      const onPage = (await currentVideoSrcs(page)).length;
      console.log(
        `FlowProvider: still waiting for the clip — ${Math.round((Date.now() - started) / 1000)}s elapsed, ` +
          `${onPage} video source(s) in the DOM, ${observedUrls.size} video URL(s) seen on the network ` +
          `(${priorSrcs.size} known before submitting), tabs: ${page
            .context()
            .pages()
            .map((pg) => pg.url().replace(/^https?:\/\//, "").slice(0, 45))
            .join(" | ")}` +
          (progress ? `, Flow reports ${progress} rendered` : ", no progress reported by Flow yet")
      );
    }

    // The run spends most of its life here, so this is the checkpoint that
    // decides whether a stop feels immediate or takes minutes.
    await abortableDelay(3000);
  }

  await saveDebugScreenshot(page, "render-wait-timeout");
  throw new Error(
    `FlowProvider: no new clip appeared within ${Math.round(timeoutMs / 1000)}s` +
      (lastProgress ? ` (last progress seen: ${lastProgress})` : " (no progress indicator was ever shown)")
  );
}

// Drives Google Flow through an already-logged-in GoLogin browser profile
// (via CDP): create a project, type the scene prompt, submit it, wait for
// the render, and download the finished clip. Since this whole sequence
// (including the render wait) is done synchronously inside generateClip,
// the result is stashed in memory keyed by job id, the same pattern
// OmniProvider uses for its own synchronous API — pollStatus just hands
// back what's already sitting there.
export class FlowProvider implements VideoGenProvider {
  private results = new Map<string, { result: ClipStatusResult; resolvedAt: number | null }>();

  // clip.service.ts submits a whole batch with Promise.all, because for the
  // API-backed providers generateClip() only fires off a request and returns
  // a job id. This provider instead drives a real browser for the entire
  // clip, and a single GoLogin profile can only be driven by one run at a
  // time — the first run to finish used to close the shared browser out from
  // under the others ("Target page, context or browser has been closed").
  //
  // So: return a job id immediately like the other providers do, and run the
  // browser work in the background against a profile checked out of the pool.
  // Concurrency is therefore exactly the number of configured profiles —
  // select 2 clips and 2 profiles open, select 3 and 3 render side by side;
  // a bigger batch waits for a profile to come free.

  async generateClip(params: GenerateClipParams): Promise<GenerateClipResult> {
    const jobId = `flow_${nanoid()}`;
    this.results.set(jobId, { result: { status: "pending" }, resolvedAt: null });

    // Registered synchronously, before anything is awaited, so a stop that
    // arrives while the run is still queueing for a profile finds it.
    const controller = registerFlowRun(jobId);
    createFlowLogBuffer(jobId);

    const startedAt = Date.now();

    // The whole body runs inside the run context — including the queue wait,
    // so "waiting for a profile" is captured into this job's log too, which
    // is exactly what someone staring at a stuck clip wants to see.
    void withFlowRun({ jobId, label: jobId.slice(5, 11) }, async () => {
      // Held only for the window where this function still owns the profile.
      // runFlow takes ownership the moment it is entered, so this is cleared
      // immediately before calling it.
      let release: (() => void) | undefined;
      try {
        console.log(
          `FlowProvider: queued ${jobId} (${params.referenceImages.length} reference image(s)) — ` +
            describeFlowPool()
        );

        const acquired = await acquireFlowProfile(controller.signal);
        release = acquired.release;
        markAcquired(jobId, acquired.profileId, acquired.profileIndex);
        // Covers the race where a slot was handed over in the same tick the
        // abort fired, so the waiter could not be spliced out of the queue.
        throwIfAborted();

        console.log(
          `FlowProvider: starting ${jobId} on profile ${acquired.profileId} ` +
            `(p${acquired.profileIndex}) — ${describeFlowPool()}`
        );
        this.results.set(jobId, { result: { status: "running" }, resolvedAt: null });

        release = undefined;
        const result = await this.runFlow(params, acquired.profileId, acquired.release);
        this.results.set(jobId, { result, resolvedAt: Date.now() });
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `FlowProvider: ${jobId} ${result.status} after ${seconds}s` +
            (result.videoBuffer ? ` — ${(result.videoBuffer.length / 1024 / 1024).toFixed(2)} MB downloaded` : "") +
            (result.error ? ` — ${result.error}` : "")
        );
      } catch (err) {
        // A stopped run can surface as anything — a checkpoint's FlowAbortError,
        // or whatever Playwright call happened to reject first when the browser
        // was closed out from under it ("Target page ... has been closed").
        // The registry knows why the run really ended, so prefer it over the
        // error that happened to arrive, rather than sniffing error strings.
        const reason = abortReasonOf(jobId);
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const message = reason ?? describeError(err);
        if (reason) console.log(`FlowProvider: ${jobId} stopped after ${seconds}s — ${reason}`);
        else console.error(`FlowProvider: ${jobId} threw — ${message}`);

        this.results.set(jobId, {
          result: { status: "failed", error: message },
          resolvedAt: Date.now(),
        });

        // Only reachable when the run was stopped before runFlow took over —
        // otherwise runFlow gives the profile back itself, once its Orbita
        // browser has actually shut down, so the next clip never starts on a
        // profile that is still closing.
        if (release) {
          release();
          console.log(`FlowProvider: released the profile — ${describeFlowPool()}`);
        }
      } finally {
        finishFlowRun(jobId);
        finishFlowLogBuffer(jobId);
      }
    }).catch(() => undefined);

    return { jobId };
  }

  // Stops an in-flight run. Returns false if the job is already finished or
  // unknown (a restart loses the registry), in which case the caller still
  // needs to unstick the block's own state.
  abortRun(jobId: string, reason: string): boolean {
    return abortFlowRun(jobId, reason);
  }

  getRunLog(jobId: string, since: number, includeAll: boolean): FlowLogPage {
    return readFlowLog(jobId, since, includeAll);
  }

  async pollStatus(jobId: string): Promise<ClipStatusResult> {
    const entry = this.results.get(jobId);
    if (!entry) {
      return { status: "failed", error: "Unknown Flow job id (server may have restarted mid-generation)" };
    }

    // Deliberately NOT deleted once it resolves. Consuming the result on
    // first read meant that if the caller then failed to persist it — a
    // Supabase upload error, a transient "JWT issued at future" clock skew,
    // any network blip — the downloaded video was gone for good and the
    // block sat in clip_generating forever with nothing left to retry.
    // Keeping it lets the next poll simply try the upload again. The caller
    // stops polling once it records the clip, so this is not re-done
    // needlessly; entries are pruned by age instead.
    this.pruneResolvedResults();
    pruneFlowLogBuffers();
    return entry.result;
  }

  // Bounds memory for kept results: a finished clip buffer is a couple of MB,
  // so hold them only long enough for the caller to retry a failed persist.
  private pruneResolvedResults(): void {
    const cutoff = Date.now() - RESULT_RETENTION_MS;
    for (const [id, entry] of this.results) {
      const resolved = entry.result.status === "succeeded" || entry.result.status === "failed";
      if (resolved && entry.resolvedAt !== null && entry.resolvedAt < cutoff) {
        this.results.delete(id);
      }
    }
  }

  private async runFlow(
    params: GenerateClipParams,
    profileId: string,
    release: () => void
  ): Promise<ClipStatusResult> {
    let session: Awaited<ReturnType<typeof getFlowBrowserPage>>;
    try {
      session = await getFlowBrowserPage(profileId);
    } catch (err) {
      // Nothing was started, so the profile is free again immediately.
      release();
      throw err;
    }
    const { page, close } = session;
    // From here on a stop can tear the browser down, which is what interrupts
    // whatever Playwright call the run is parked on.
    const ctx = currentFlowRun();
    if (ctx) attachClose(ctx.jobId, close);
    try {
      const result = await this.runFlowOnPage(page, params, profileId);
      console.log("FlowProvider: run finished, handing back the clip (closing the profile in the background)");
      return result;
    } finally {
      // Close the profile/browser on success or failure so a generation
      // never leaves an Orbita process running and the profile locked —
      // but do NOT await it. goLogin.stop() syncs the whole profile to S3,
      // which can take a long time, and awaiting it here delayed handing
      // the finished clip back to the caller (the run looked hung after the
      // video had already been downloaded).
      void close()
        .catch((closeErr) => {
          console.warn("FlowProvider: closing the GoLogin profile failed", closeErr);
        })
        // Only now is this profile genuinely free for the next queued clip.
        .finally(release);
    }
  }

  private async runFlowOnPage(
    page: Page,
    params: GenerateClipParams,
    profileId: string
  ): Promise<ClipStatusResult> {
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
    // Before anything else: a profile whose Google session has expired lands
    // on a sign-in screen, and every step below would then fail slowly and
    // expensively (an 8s selector timeout plus an LLM call asking where the
    // "New project" button is on a page that only offers "Sign in").
    await assertFlowSignedIn(page, profileId);
    throwIfAborted();
    await readingPause(page);

    // GoLogin's --restore-last-session can drop us straight back into the
    // last-used project instead of a "start a new project" screen — in that
    // case there is no "New project" element on the page at all, and asking
    // the AI to find one anyway just produces a confident-but-wrong guess
    // (it picked the unrelated top-nav "+" menu once). Check the URL first
    // and only look for "New project" when we're not already in a project.
    if (!/\/project\//.test(page.url())) {
      try {
        await clickWithAiFallback({
          page,
          goalDescription: "Start creating a new Flow project (usually a button/link labeled 'New project').",
          primaryLocator: () => page.getByText("New project", { exact: true }),
        });
      } catch (err) {
        await saveDebugScreenshot(page, "new-project-click-failed");
        throw err;
      }
      // Every step after this assumes we're inside a project, so confirm we
      // actually got there. Flow navigates client-side (SPA), so the URL
      // updates a beat *after* the click — sampling page.url() once right
      // away races that navigation and reports a false failure. waitForURL
      // waits for the real thing and only fails if it never happens.
      try {
        await page.waitForURL(/\/project\//, { timeout: 30000 });
      } catch {
        // The click did not throw, it just did nothing useful — which the
        // per-step AI fallback never sees, because it only runs when a
        // selector times out. Hand the goal to the agent instead of failing
        // outright.
        console.warn("FlowProvider: click did not open a project — handing to the agent");
        const opened = await runFlowAgent({
          page,
          goal:
            "Open a Flow project so a video can be generated in it. On the Flow home page this means " +
            "clicking the '+ New project' tile; if a project already exists you may open that instead. " +
            "Success is the browser landing on a URL containing /project/.",
          context:
            "Automating Google Flow to generate one video clip. A click on 'New project' was already " +
            "attempted but the page never navigated to a project URL.",
          isDone: async () => /\/project\//.test(page.url()),
          maxSteps: 8,
        });
        if (!opened) {
          await saveDebugScreenshot(page, "new-project-did-not-navigate");
          throw new Error(
            `FlowProvider: could not open a project page (still at ${page.url()})`
          );
        }
        await page.waitForURL(/\/project\//, { timeout: 15000 }).catch(() => {});
      }
      await humanPause();
    } else {
      console.log("FlowProvider: already inside a project (session-restored), reusing it instead of creating a new one");
    }

    // Clicking "New project" already navigates straight into the project
    // page — no further confirmation click is needed. The "Upload media"
    // button on this page opens a native OS file picker; it's only clicked
    // when there's actually a reference image to attach.
    if (params.referenceImages.length > 0) {
      try {
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), "flow-ref-"));
        const tmpFiles: string[] = [];
        for (const ref of params.referenceImages) {
          const { buffer: imageBuffer, mimeType } = await downloadAsset(ref.path);

          // ref.name is a reference label ("character_1"), not a filename —
          // writing the temp file under it leaves the upload with no file
          // extension, and Flow then can't tell what the file is and
          // rejects it ("This video format is not supported"). Take the
          // extension from the stored object's own path, falling back to
          // one derived from its mime type.
          const mimeExt =
            mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
          const ext = path.extname(ref.path) || mimeExt;
          const baseName = path.basename(ref.name, path.extname(ref.name)).replace(/[^a-z0-9_-]/gi, "_");
          const tmpFile = path.join(tmpDir, `${baseName || "reference"}${ext}`);

          await writeFile(tmpFile, imageBuffer);
          tmpFiles.push(tmpFile);
        }
        throwIfAborted();
        console.log(`FlowProvider: attaching ${tmpFiles.length} reference image(s): ${tmpFiles.join(", ")}`);

        // "Upload media" only exists inside the attach-media panel, which is
        // opened by the icon-only "+" in the prompt bar (not the unrelated
        // "+" in the top-right nav, whose menu contains a same-named item).
        // openAttachMediaPanel tries several structural strategies and
        // verifies the panel actually opened after each; the AI is the last
        // resort if none of them land.
        if (!(await openAttachMediaPanel(page))) {
          console.warn("FlowProvider: no selector strategy opened the attach panel, asking the AI");
          await clickWithAiFallback({
            page,
            goalDescription:
              "Open the attach-media panel by clicking the small '+' icon docked inside the prompt bar " +
              "at the bottom of the screen, right next to the 'Agent' pill. It is an icon-only button " +
              "with no text label, so look at the image rather than the accessibility tree. Do NOT " +
              "click the '+' icon in the top-right navigation bar, and do NOT click the back arrow in " +
              "the top-left corner — both are different, unrelated controls.",
            primaryLocator: () => page.getByText("Agent", { exact: true }).locator("xpath=preceding::button[1]"),
            primaryTimeoutMs: 3000,
          });
          await humanPause();

          // Last resort: hand the whole objective to the agent, which sees
          // the page and decides its own next actions rather than being
          // asked to locate one specific pre-decided element.
          if (!(await attachPanelIsOpen(page))) {
            const opened = await runFlowAgent({
              page,
              goal:
                "Open the attach-media panel so reference images can be added to the prompt. It is " +
                "opened by the small '+' icon inside the prompt bar at the bottom of the screen. The " +
                "panel shows a 'Search assets' box, tabs (Images/Videos/Voices/Characters/Uploads), " +
                "and an 'Upload media' button.",
              context:
                "Automating Google Flow to generate one video clip. We are inside a project and about " +
                "to upload reference images, attach them to the prompt, then type the prompt and " +
                "generate. The scripted selectors for the '+' button did not work.",
              isDone: () => attachPanelIsOpen(page),
            });
            if (!opened) {
              await saveDebugScreenshot(page, "attach-panel-never-opened");
              throw new Error(
                "FlowProvider: could not open the attach-media panel (structural selectors, AI fallback and agent all failed)"
              );
            }
          }
        }

        // "Upload media" triggers a native OS file dialog rather than
        // exposing a pre-existing <input type="file"> to target directly —
        // Playwright's filechooser event is the standard (CDP-backed) way
        // to hand it files without that dialog ever needing to render.
        // If the click below fails, this promise is left pending; without
        // the no-op .catch() here, its eventual rejection (e.g. once
        // browser.close() runs in the outer finally) becomes an unhandled
        // rejection that crashes the whole Node process, not just this job.
        const fileChooserPromise = page.waitForEvent("filechooser");
        fileChooserPromise.catch(() => {});
        await clickWithAiFallback({
          page,
          goalDescription:
            "Click the 'Upload media' button inside the attach-media panel that just opened above the " +
            "prompt bar. Do NOT click any 'Upload media' item in the top-right navigation menu — only " +
            "the one inside this panel.",
          primaryLocator: () => page.getByRole("button", { name: "Upload media" }),
        });
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(tmpFiles);
        // Uploads need time to land server-side before the assets become
        // selectable in the panel.
        await humanPause(3000, 5000);

        // Capture the panel's real markup once, so the asset-tile selectors
        // below can be corrected from actual DOM rather than inferred from
        // screenshots.
        await saveDebugScreenshot(page, "attach-panel-after-upload");

        const attached = await addUploadedImagesToPrompt(page, tmpFiles);
        // A partial attach is just as wrong as none: generating with only
        // some of the reference images produces a clip with the wrong
        // character(s). Any shortfall goes to the agent, and if the agent
        // can't finish the job the run fails rather than quietly producing
        // an incorrect video.
        if (attached < tmpFiles.length) {
          if (attached > 0) {
            console.warn(
              `FlowProvider: only ${attached} of ${tmpFiles.length} reference image(s) attached — handing to the agent`
            );
          }
          const fileNames = tmpFiles.map((f) => path.basename(f)).join(", ");
          const agentAttached = await runFlowAgent({
            page,
            goal:
              `Attach ALL ${tmpFiles.length} uploaded reference image(s) (${fileNames}) to the prompt — ` +
              `so far only ${attached} of them got attached. In the attach-media panel, select every ` +
              "one of those asset rows (ctrl+click each row to build a multi-selection; the panel shows " +
              "a running 'N items selected' counter), then click the button at the bottom-right that " +
              "reads 'Add to prompt' (or 'Add N items to prompt'). IMPORTANT: select rows with " +
              "ctrl+click only — a plain click attaches that one image immediately and closes the " +
              "panel. That button is " +
              "disabled while a file is still uploading, so wait rather than clicking it disabled. If " +
              "the panel has closed, reopen it with the '+' icon in the prompt bar.",
            context:
              "Automating Google Flow to generate one video clip. The reference images are already " +
              `uploaded, but only ${attached} of ${tmpFiles.length} are attached to the prompt. All of ` +
              "them must be attached before the prompt is submitted, otherwise the generated video " +
              "uses the wrong characters.",
            // The confirm button disappearing only means the panel closed —
            // it says nothing about whether the images actually landed on
            // the prompt, which is why a previous version declared success
            // at step 0 without doing anything. Count the attachment
            // thumbnails rendered in the prompt bar instead.
            isDone: async () => (await attachedThumbnailCount(page)) >= tmpFiles.length,
            maxSteps: 12,
          });
          if (!agentAttached) {
            await saveDebugScreenshot(page, "add-to-prompt-incomplete");
            throw new Error(
              `FlowProvider: only attached ${attached} of ${tmpFiles.length} reference image(s) and the ` +
                "agent could not attach the rest — refusing to generate with missing references"
            );
          }
        }
      } catch (err) {
        await saveDebugScreenshot(page, "attach-reference-image-failed");
        throw err;
      }
      await humanPause();
    }

    // The prompt box is a ProseMirror rich-text editor (Flow moved to
    // flow.google.com / Angular; it was Slate on the old labs.google build,
    // so [data-slate-editor] now matches nothing and every paste silently
    // went nowhere). Real markup:
    //   <flow-rich-text-editor class="prompt-input">
    //     <div class="prosemirror-editor">
    //       <div contenteditable="true" class="ProseMirror">
    const promptBoxLocator = () =>
      page.locator('flow-rich-text-editor .ProseMirror[contenteditable="true"]')
        .or(page.locator('.ProseMirror[contenteditable="true"]'))
        .or(page.locator('[data-slate-editor="true"]'))
        .first();

    throwIfAborted();
    console.log(`FlowProvider: pasting the prompt (${params.prompt.length} chars)`);
    try {
      await fillWithAiFallback({
        page,
        goalDescription:
          "The rich-text prompt box where the video description is typed — a contenteditable editor " +
          "with placeholder text 'What do you want to create?'.",
        primaryLocator: promptBoxLocator,
        text: params.prompt,
      });
      console.log("FlowProvider: prompt pasted");
    } catch (err) {
      await saveDebugScreenshot(page, "prompt-fill-failed");
      throw err;
    }
    await humanPause();

    // No overlay handling here on purpose: the "read more" overlay closes
    // itself when "Add to prompt" is clicked, and submitting works with it
    // open regardless. The step that used to live here was optional, its
    // selector never matched, and it therefore spent an LLM call on every
    // single run to accomplish nothing.

    // Closing the overlay (or any other intervening step) has been observed
    // to occasionally knock the Slate editor back to empty — verify the
    // prompt actually survived before submitting, and re-paste it if not,
    // rather than discovering it via a "Prompt must be provided" error
    // after Enter.
    const promptStillThere = (await promptBoxLocator().innerText().catch(() => "")).trim();
    if (!promptStillThere || !promptStillThere.startsWith(params.prompt.trim().slice(0, 20))) {
      console.warn("FlowProvider: prompt box was empty right before submit, re-pasting");
      try {
        await fillWithAiFallback({
          page,
          goalDescription:
            "The rich-text prompt box where the video description is typed — a contenteditable editor " +
            "with placeholder text 'What do you want to create?'.",
          primaryLocator: promptBoxLocator,
          text: params.prompt,
        });
        await humanPause();
      } catch (err) {
        await saveDebugScreenshot(page, "prompt-refill-failed");
        throw err;
      }
    }

    // Snapshot the clips already present *before* submitting, so the one
    // this run produces can be told apart from anything already in the
    // project (projects are reused across runs now).
    // Start watching network traffic BEFORE submitting so the clip's URL is
    // captured the instant the browser fetches it.
    const videoWatch = watchForVideoUrls(page);
    const priorSrcs = new Set([...(await currentVideoSrcs(page)), ...videoWatch.urls]);
    // Tracked separately from priorSrcs because a thumbnail URL is a JPEG,
    // never something to download as the clip — it only marks which tiles
    // already existed.
    const priorThumbnails = new Set(await currentVideoThumbnails(page));
    if (priorSrcs.size > 0) {
      console.log(`FlowProvider: ${priorSrcs.size} existing clip(s) in this project before submitting`);
    }

    // Submit by focusing the prompt box and pressing Enter, rather than
    // clicking the arrow_forward button — falls back to that button only if
    // Enter doesn't get picked up (e.g. focus was lost after closing the
    // overlay above).
    try {
      await promptBoxLocator().click();
      await humanPause(150, 400);
      await page.keyboard.press("Enter");
      console.log("FlowProvider: submitted the prompt (Enter) — polling for the generated clip");
    } catch (err) {
      console.warn("FlowProvider: submitting via Enter failed, falling back to the arrow_forward button", err);
      try {
        await clickWithAiFallback({
          page,
          goalDescription:
            "Submit the prompt to start generating the video now that it has been typed in — usually a " +
            "round button with an 'arrow_forward' icon next to the prompt box, enabled once text is " +
            "present.",
          primaryLocator: () => page.getByRole("button", { name: "arrow_forward Create", exact: true }),
        });
      } catch (fallbackErr) {
        await saveDebugScreenshot(page, "submit-failed");
        throw fallbackErr;
      }
    }

    let renderedSrc: string;
    try {
      renderedSrc = await waitForNewRenderedVideo(
        page,
        priorSrcs,
        RENDER_TIMEOUT_MS,
        videoWatch.urls,
        priorThumbnails
      );
    } catch (err) {
      await saveDebugScreenshot(page, "render-wait-failed");
      throw err;
    } finally {
      videoWatch.stop();
    }

    // The finished tile's <video> element, addressed by the exact src that
    // waitForNewRenderedVideo settled on — not `.first()`, which could be a
    // clip that was already in the project.
    const videoLocator = page.locator(`video[src="${renderedSrc}"]`).first();

    // Primary: that src is a direct (redirecting) media URL on the same
    // origin — fetching it through the browser context's own request API
    // (shares cookies/session) gets the raw bytes without needing to hover
    // the tile and click through a menu at all.
    try {
      const absoluteUrl = new URL(renderedSrc, page.url()).toString();
      throwIfAborted();
      console.log(`FlowProvider: downloading the clip from ${absoluteUrl.slice(0, 120)}`);
      const response = await page.context().request.get(absoluteUrl);
      if (!response.ok()) {
        throw new Error(`Fetching video src failed: ${response.status()} ${await response.text()}`);
      }
      // /asb/ serves any asset, not just clips, so confirm these really are
      // video bytes before they get stored as an .mp4 — an HTML error page
      // saved under a video name fails much later and much more confusingly.
      const contentType = response.headers()["content-type"] ?? "";
      if (contentType && !/^(video\/|application\/octet-stream)/i.test(contentType)) {
        throw new Error(`Video src returned ${contentType}, not video bytes`);
      }
      const videoBuffer = await response.body();
      console.log(
        `FlowProvider: downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB of video`
      );
      return { status: "succeeded", videoBuffer };
    } catch (directFetchErr) {
      console.warn(
        "FlowProvider: direct video-src fetch failed, falling back to the tile's Download menu",
        directFetchErr
      );
    }

    // Fallback: hover the video tile to reveal its toolbar, open the
    // "more options" (⋮) menu, and click Download, capturing the browser's
    // download event.
    try {
      await videoLocator.hover();
      await humanPause(200, 500);
      await clickWithAiFallback({
        page,
        goalDescription:
          "Open the 'more options' (three-dot ⋮) menu on the generated video's thumbnail tile — only " +
          "visible after hovering the tile.",
        primaryLocator: () => page.getByRole("button", { name: /more/i }),
      });
      await humanPause();

      // Same reasoning as the filechooser promise above: if the click below
      // fails, this must not become an unhandled rejection when the
      // browser later closes.
      const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS });
      downloadPromise.catch(() => {});
      await clickWithAiFallback({
        page,
        goalDescription: "Click 'Download' in the menu that just opened, to download the generated video.",
        primaryLocator: () => page.getByText("Download", { exact: true }),
      });
      const download = await downloadPromise;
      const videoBuffer = await streamToBuffer(await download.createReadStream());
      return { status: "succeeded", videoBuffer };
    } catch (err) {
      await saveDebugScreenshot(page, "download-failed");
      throw err;
    }
  }
}
