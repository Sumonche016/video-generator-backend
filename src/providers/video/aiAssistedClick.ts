import type { Locator, Page } from "playwright";
import { getLLMProvider } from "../../config/providers.config.js";

interface AiElementDecision {
  found: boolean;
  // The AI's escape hatch for when our code assumed an action was needed
  // but the page is already in the desired state (e.g. a step written for
  // "create a new project" running on a session-restored page that's
  // already inside one) — without this, the AI is forced to point at
  // *something* to click even when nothing on the page actually matches,
  // which is exactly how it once clicked an unrelated top-nav menu.
  alreadySatisfied?: boolean;
  role?: string;
  name?: string;
  x?: number;
  y?: number;
  reasoning?: string;
}

// gpt-4o pricing at the time of writing: $2.50 per 1M input tokens,
// $10.00 per 1M output tokens. Logged per call so LLM spend from the
// automation is visible in the same place as everything else, and so the
// model's raw answer can be inspected when a decision looks wrong.
const USD_PER_INPUT_TOKEN = 2.5 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 10 / 1_000_000;

export function logLlmCall(label: string, raw: unknown, text: string): void {
  const usage = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  if (usage) {
    const inTokens = usage.prompt_tokens ?? 0;
    const outTokens = usage.completion_tokens ?? 0;
    const cost = inTokens * USD_PER_INPUT_TOKEN + outTokens * USD_PER_OUTPUT_TOKEN;
    console.log(
      `${label}: llm usage in=${inTokens} out=${outTokens} tokens, cost≈$${cost.toFixed(4)}`
    );
  } else {
    console.log(`${label}: llm usage unavailable`);
  }
  console.log(`${label}: llm raw response: ${text.replace(/\s+/g, " ").trim().slice(0, 600)}`);
}

function parseDecision(text: string): AiElementDecision {
  // Models sometimes wrap JSON in a ```json fence despite being asked not to.
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned) as AiElementDecision;
}

// Asks a vision-capable LLM to locate an element when our fixed selector
// can't find it (the page rendered in a different locale, Flow shipped a UI
// change, network/proxy issues left the page in an unexpected state, etc).
// The screenshot is the primary source of truth — the accessibility tree is
// only a supplementary hint for turning a *visible* element into a stable
// role/name locator. Icon-only buttons with no aria-label/text routinely
// don't appear in the tree at all despite being plainly visible in the
// image; treating the tree as authoritative (an earlier version of this
// prompt did) causes the model to report "not found" for things it can
// plainly see, which is wrong.
async function askAiForElement(page: Page, goalDescription: string): Promise<AiElementDecision> {
  const screenshot = await page.screenshot({ fullPage: false });
  const ariaSnapshot = await page.locator("body").ariaSnapshot();

  const llm = getLLMProvider();
  const result = await llm.chat({
    systemPrompt:
      "You control a web browser for a fixed automation task. You will be shown a screenshot of the " +
      "current page and its accessibility tree. Identify the single element needed to achieve the " +
      "stated goal.\n\n" +
      "The SCREENSHOT IMAGE is the primary source of truth — look at it directly. The accessibility " +
      "tree is only a supplementary aid for naming an element you can already see in the image; it is " +
      "NOT exhaustive. Icon-only buttons with no visible text or aria-label (a bare '+', a hamburger " +
      "icon, a lone glyph) frequently do not appear in the tree at all, even though they are clearly " +
      "visible in the screenshot. NEVER report found=false just because something is absent from the " +
      "tree — check the image first. If you can visually identify a plausible matching element in the " +
      "image, report it (via role/name if the tree happens to have it, otherwise via its pixel " +
      "coordinates in the image) rather than concluding it doesn't exist.\n\n" +
      "Only report alreadySatisfied=true or found=false when you have actually looked at the image and " +
      "confirmed there is no matching element there either — not merely because the tree lacks it. " +
      "Also don't guess at an unrelated element just because it seems vaguely related to the goal's " +
      "topic — if the goal is already accomplished (e.g. asked to 'start a new project' but the page " +
      "already shows an open project), use alreadySatisfied=true instead.\n\n" +
      'Respond with ONLY a JSON object, no prose, no markdown fence: ' +
      '{"found": boolean, "alreadySatisfied": boolean, "role": string | null, "name": string | null, ' +
      '"x": number | null, "y": number | null, "reasoning": string}.',
    messages: [
      {
        role: "user",
        content: `Goal: ${goalDescription}\n\nAccessibility tree (supplementary — may omit visible icon-only elements):\n${ariaSnapshot}`,
        images: [{ base64: screenshot.toString("base64") }],
      },
    ],
    responseFormat: "json",
  });

  logLlmCall("askAiForElement", result.raw, result.text);

  let decision: AiElementDecision;
  try {
    decision = parseDecision(result.text);
  } catch (parseErr) {
    console.error(
      `askAiForElement: failed to parse LLM response as JSON for goal "${goalDescription}". Raw response:`,
      result.text
    );
    throw parseErr;
  }

  // Always log the full decision, not just on failure — this is the actual
  // evidence for whether the LLM is reasoning correctly, instead of us
  // guessing after the fact from a bare "could not find" message.
  console.log(`askAiForElement: goal="${goalDescription}" decision=${JSON.stringify(decision)}`);

  return decision;
}

async function resolveAiLocator(page: Page, decision: AiElementDecision): Promise<Locator | null> {
  if (decision.role && decision.name) {
    const locator = page.getByRole(decision.role as Parameters<Page["getByRole"]>[0], { name: decision.name });
    const count = await locator.count();
    if (count > 0) return locator;
    console.warn(
      `resolveAiLocator: LLM-suggested role="${decision.role}" name="${decision.name}" matched 0 elements on the page` +
        (typeof decision.x === "number" ? " — falling back to its coordinates" : " and it gave no coordinates either")
    );
  }
  return null;
}

function delay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

// Playwright's locator.click() dispatches the mouse straight to the
// element's exact center in one instant hop — a click pattern real user
// input never produces, and exactly the kind of automation fingerprint
// detection looks for. This instead moves the mouse there over several
// interpolated steps, lands at a randomized offset from dead-center rather
// than the exact midpoint, pauses briefly (as if aiming), then presses and
// releases with its own small delay.
async function humanClick(page: Page, locator: Locator, timeoutMs = 8000): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  const box = await locator.boundingBox();
  if (!box) {
    // Not visible/stable enough to get a bounding box — fall back to
    // Playwright's own click, which still auto-waits for actionability.
    await locator.click({ timeout: timeoutMs });
    return;
  }
  const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
  const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);
  await page.mouse.move(targetX, targetY, { steps: 15 + Math.floor(Math.random() * 10) });
  await delay(60, 200);
  await page.mouse.down();
  await delay(40, 120);
  await page.mouse.up();
}

async function humanClickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 15 + Math.floor(Math.random() * 10) });
  await delay(60, 200);
  await page.mouse.down();
  await delay(40, 120);
  await page.mouse.up();
}

export interface AiAssistedClickOptions {
  page: Page;
  goalDescription: string;
  primaryLocator: () => Locator;
  primaryTimeoutMs?: number;
  /** Max AI attempts after the primary selector fails — each re-screenshots
   * the actual current state, so a wrong first guess (whose click changed
   * the page) still gets a real shot at recovering rather than compounding
   * the mistake silently. Defaults to 2. */
  maxAiAttempts?: number;
}

// Tries the fast, deterministic selector first; only pays for an LLM call
// when that actually times out, so the normal (working) path stays free and
// fast. Not a substitute for fixing selectors that are known to be wrong —
// this is a resilience net for drift/locale/UI changes we haven't seen yet.
export async function clickWithAiFallback(options: AiAssistedClickOptions): Promise<void> {
  const { page, goalDescription, primaryLocator, primaryTimeoutMs = 8000, maxAiAttempts = 2 } = options;

  try {
    await humanClick(page, primaryLocator(), primaryTimeoutMs);
    return;
  } catch (primaryErr) {
    console.warn(
      `clickWithAiFallback: primary selector timed out for "${goalDescription}", asking LLM for help`
    );

    for (let attempt = 1; attempt <= maxAiAttempts; attempt++) {
      let decision: AiElementDecision;
      try {
        decision = await askAiForElement(page, goalDescription);
      } catch (aiErr) {
        console.error("clickWithAiFallback: LLM lookup failed", aiErr);
        throw primaryErr;
      }

      if (decision.alreadySatisfied) {
        console.log(`clickWithAiFallback: LLM says the goal is already satisfied — "${goalDescription}"`);
        return;
      }

      if (!decision.found) {
        console.error("clickWithAiFallback: LLM could not find the element either", decision.reasoning);
        throw primaryErr;
      }

      const locator = await resolveAiLocator(page, decision);
      if (locator) {
        try {
          await humanClick(page, locator, 5000);
          return;
        } catch (roleClickErr) {
          console.warn(
            `clickWithAiFallback: AI-suggested role="${decision.role}" name="${decision.name}" didn't resolve (attempt ${attempt}/${maxAiAttempts}), retrying with a fresh look`,
            roleClickErr
          );
          continue;
        }
      }

      if (typeof decision.x === "number" && typeof decision.y === "number") {
        try {
          await humanClickAt(page, decision.x, decision.y);
          return;
        } catch (coordClickErr) {
          console.warn(
            `clickWithAiFallback: AI-suggested coordinates didn't work (attempt ${attempt}/${maxAiAttempts}), retrying with a fresh look`,
            coordClickErr
          );
          continue;
        }
      }
    }

    throw primaryErr;
  }
}

export interface AiAssistedFillOptions {
  page: Page;
  goalDescription: string;
  primaryLocator: () => Locator;
  text: string;
  primaryTimeoutMs?: number;
}

// A multi-paragraph prompt contains real newline characters. Typing it via
// keyboard.type() sends each newline as an actual Enter keypress, which a
// chat-style rich-text box (e.g. Flow's Slate-based prompt editor) treats as
// "submit" — cutting the prompt off mid-way and firing generation early.
// locator.fill() avoids that, but React-controlled editors like Slate don't
// treat a plain DOM value assignment as real input — the field looks filled
// right after, then silently reverts to empty on the next re-render (e.g.
// when it's clicked again to focus it for Enter). page.keyboard.insertText()
// dispatches one real "input"/"beforeinput" event, which Slate's own change
// handling actually picks up, while still being a single atomic op (so no
// per-character Enter-as-newline risk either).
//
// keyboard.insertText() already goes through CDP's Input.insertText under
// the hood for Chromium, but verify it actually stuck — if the editor's own
// re-render still dropped it, retry with an explicit raw CDP session call
// (bypassing Playwright's own event dispatch entirely) before giving up.
async function pasteText(page: Page, locator: Locator, text: string): Promise<void> {
  await humanClick(page, locator);
  await page.keyboard.insertText(text);

  const expectedStart = text.trim().slice(0, 30);
  const actual = await locator.innerText().catch(() => "");
  if (expectedStart.length === 0 || actual.trim().startsWith(expectedStart)) {
    return;
  }

  console.warn("pasteText: keyboard.insertText did not stick, retrying via a raw CDP Input.insertText call");
  const cdpSession = await page.context().newCDPSession(page);
  try {
    await locator.click();
    await cdpSession.send("Input.insertText", { text });
  } finally {
    await cdpSession.detach().catch(() => {});
  }
}

// Same resilience pattern as clickWithAiFallback, but for filling text into a
// field (the Flow prompt box) rather than clicking a button.
export async function fillWithAiFallback(options: AiAssistedFillOptions): Promise<void> {
  const { page, goalDescription, primaryLocator, text, primaryTimeoutMs = 8000 } = options;
  const maxAiAttempts = 2;

  try {
    const locator = primaryLocator();
    await locator.waitFor({ state: "visible", timeout: primaryTimeoutMs });
    await pasteText(page, locator, text);
    return;
  } catch (primaryErr) {
    console.warn(
      `fillWithAiFallback: primary selector timed out for "${goalDescription}", asking LLM for help`
    );

    for (let attempt = 1; attempt <= maxAiAttempts; attempt++) {
      let decision: AiElementDecision;
      try {
        decision = await askAiForElement(page, goalDescription);
      } catch (aiErr) {
        console.error("fillWithAiFallback: LLM lookup failed", aiErr);
        throw primaryErr;
      }

      if (decision.alreadySatisfied) {
        console.log(`fillWithAiFallback: LLM says the goal is already satisfied — "${goalDescription}"`);
        return;
      }

      if (!decision.found) {
        console.error("fillWithAiFallback: LLM could not find the element either", decision.reasoning);
        throw primaryErr;
      }

      const locator = await resolveAiLocator(page, decision);
      if (locator) {
        try {
          await pasteText(page, locator, text);
          return;
        } catch (roleFillErr) {
          console.warn(
            `fillWithAiFallback: AI-suggested role="${decision.role}" name="${decision.name}" didn't resolve (attempt ${attempt}/${maxAiAttempts}), retrying with a fresh look`,
            roleFillErr
          );
          continue;
        }
      }

      if (typeof decision.x === "number" && typeof decision.y === "number") {
        try {
          await humanClickAt(page, decision.x, decision.y);
          await page.keyboard.insertText(text);
          return;
        } catch (coordFillErr) {
          console.warn(
            `fillWithAiFallback: AI-suggested coordinates didn't work (attempt ${attempt}/${maxAiAttempts}), retrying with a fresh look`,
            coordFillErr
          );
          continue;
        }
      }
    }

    throw primaryErr;
  }
}
