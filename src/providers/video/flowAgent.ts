import type { Page } from "playwright";
import { getLLMProvider } from "../../config/providers.config.js";
import { logLlmCall } from "./aiAssistedClick.js";

// A goal-driven recovery agent for the Flow automation.
//
// The per-step "find me this element" helpers in aiAssistedClick.ts answer a
// narrow question and have no idea what the run is actually trying to
// achieve, so when the page isn't in the shape a step assumed, they fail
// with no way to recover. This module instead hands the model the whole
// objective, what has already happened, and the live page — and asks for the
// single next action to take. We execute it, feed back the result, and loop.
//
// Crucially the model never invents CSS selectors: every interactive element
// is stamped with a data-agent-id and listed in the digest, and the model
// answers with one of those ids. That removes the entire class of "the AI
// suggested a selector that matches nothing" failures.

export interface AgentAction {
  action: "click" | "fill" | "press" | "hover" | "scroll" | "wait" | "done" | "fail";
  agentId?: number;
  text?: string;
  key?: string;
  ms?: number;
  reasoning: string;
}

export interface AgentRunOptions {
  page: Page;
  /** The objective, e.g. "attach both uploaded reference images to the prompt". */
  goal: string;
  /** Background the model needs: what this run is doing overall, what already happened. */
  context: string;
  /** Checked before each step; when it returns true the goal is met and the loop stops. */
  isDone?: () => Promise<boolean>;
  maxSteps?: number;
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="textbox"]',
  '[role="tab"]',
  '[role="option"]',
  '[contenteditable="true"]',
].join(", ");

/**
 * Stamps every visible interactive element with a data-agent-id and returns
 * a compact numbered listing. Sending this instead of raw HTML keeps the
 * payload small (Flow pages are megabytes of framework markup) while giving
 * the model exactly what it needs to choose a target.
 */
export async function buildPageDigest(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    document.querySelectorAll("[data-agent-id]").forEach((el) => el.removeAttribute("data-agent-id"));

    const lines: string[] = [];
    let id = 0;

    document.querySelectorAll(selector).forEach((el) => {
      const rect = el.getBoundingClientRect();
      // Skip zero-size and far-offscreen nodes — not actionable, and they
      // crowd out the elements that matter.
      if (rect.width < 2 || rect.height < 2) return;
      if (rect.bottom < -200 || rect.top > window.innerHeight + 800) return;

      el.setAttribute("data-agent-id", String(id));

      const raw = (el as HTMLElement).innerText || el.textContent || "";
      const text = raw.replace(/\s+/g, " ").trim().slice(0, 70);
      const aria = el.getAttribute("aria-label") ?? "";
      const placeholder = el.getAttribute("placeholder") ?? "";
      const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

      const parts = [`#${id}`, `<${el.tagName.toLowerCase()}>`];
      if (disabled) parts.push("[disabled]");
      if (text) parts.push(`text="${text}"`);
      if (aria && aria !== text) parts.push(`aria="${aria.slice(0, 70)}"`);
      if (placeholder) parts.push(`placeholder="${placeholder.slice(0, 50)}"`);
      parts.push(`at(${Math.round(rect.x)},${Math.round(rect.y)})`);

      lines.push(parts.join(" "));
      id++;
    });

    return lines.join("\n");
  }, INTERACTIVE_SELECTOR);
}

/** Notable non-interactive text (status, progress, errors) the model may need. */
async function buildStatusDigest(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const interesting: string[] = [];
      const seen = new Set<string>();
      const selector =
        '.loading-percentage, [role="alert"], [role="status"], .cdk-visually-hidden, .asset-title';
      document.querySelectorAll(selector).forEach((el) => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 120 || seen.has(text)) return;
        seen.add(text);
        interesting.push(text);
      });
      return interesting.slice(0, 30).join(" | ");
    })
    .catch(() => "");
}

function parseAction(raw: string): AgentAction {
  const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned) as AgentAction;
}

async function askForNextAction(
  page: Page,
  goal: string,
  context: string,
  history: string[]
): Promise<AgentAction> {
  const screenshot = await page.screenshot({ fullPage: false });
  const digest = await buildPageDigest(page);
  const status = await buildStatusDigest(page);

  const llm = getLLMProvider();
  const result = await llm.chat({
    systemPrompt:
      "You are driving a Chromium browser through Playwright to accomplish a goal on Google Flow " +
      "(labs.google / flow.google.com), an AI video generation tool. You are called when the " +
      "scripted automation got stuck, and you decide the SINGLE next action to take.\n\n" +
      "You are given: the goal, what has happened so far, a screenshot of the current page, and a " +
      "numbered list of every interactive element on the page. Each has an id (#0, #1, ...). To act " +
      "on an element, return its id in `agentId` — never write a CSS selector, and never invent an " +
      "id that is not in the list.\n\n" +
      "Available actions:\n" +
      '  {"action":"click","agentId":N} — click that element\n' +
      '  {"action":"fill","agentId":N,"text":"..."} — focus it and enter text\n' +
      '  {"action":"press","key":"Enter"} — press a key on the focused element\n' +
      '  {"action":"hover","agentId":N} — hover it (to reveal hidden controls)\n' +
      '  {"action":"scroll","agentId":N} — scroll it into view\n' +
      '  {"action":"wait","ms":3000} — wait while something loads or renders\n' +
      '  {"action":"done"} — the goal is already achieved; stop\n' +
      '  {"action":"fail"} — the goal cannot be achieved from here; stop\n\n' +
      "Rules: prefer the element list for targeting, but use the screenshot to understand layout and " +
      "state. Do NOT click elements marked [disabled] — wait instead if something must finish first. " +
      "Do NOT navigate away from the current project page (avoid back arrows and unrelated nav). " +
      "Take the smallest sensible step; you will be called again with the updated page after it runs.\n\n" +
      'Respond with ONLY a JSON object, no prose, no markdown fence, and always include a short ' +
      '"reasoning" field explaining the choice.',
    messages: [
      {
        role: "user",
        content:
          `GOAL: ${goal}\n\n` +
          `CONTEXT: ${context}\n\n` +
          `ACTIONS TAKEN SO FAR:\n${history.length ? history.join("\n") : "(none yet)"}\n\n` +
          `CURRENT URL: ${page.url()}\n\n` +
          (status ? `PAGE STATUS TEXT: ${status}\n\n` : "") +
          `INTERACTIVE ELEMENTS:\n${digest || "(none found)"}`,
        images: [{ base64: screenshot.toString("base64") }],
      },
    ],
    responseFormat: "json",
  });

  logLlmCall("flowAgent", result.raw, result.text);
  return parseAction(result.text);
}

/** Executes one agent-chosen action. Returns a short description of what happened. */
async function executeAction(page: Page, action: AgentAction): Promise<string> {
  const target =
    typeof action.agentId === "number"
      ? page.locator(`[data-agent-id="${action.agentId}"]`).first()
      : null;

  switch (action.action) {
    case "click":
      if (!target) return "no agentId supplied for click";
      await target.click({ timeout: 10000 });
      return `clicked #${action.agentId}`;
    case "fill":
      if (!target) return "no agentId supplied for fill";
      await target.click({ timeout: 10000 });
      // insertText rather than type(): a multi-paragraph prompt typed key by
      // key sends its newlines as Enter, which submits chat-style editors.
      await page.keyboard.insertText(action.text ?? "");
      return `filled #${action.agentId}`;
    case "press":
      await page.keyboard.press(action.key ?? "Enter");
      return `pressed ${action.key ?? "Enter"}`;
    case "hover":
      if (!target) return "no agentId supplied for hover";
      await target.hover({ timeout: 10000 });
      return `hovered #${action.agentId}`;
    case "scroll":
      if (!target) return "no agentId supplied for scroll";
      await target.scrollIntoViewIfNeeded({ timeout: 10000 });
      return `scrolled #${action.agentId} into view`;
    case "wait": {
      const ms = Math.min(action.ms ?? 3000, 30000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `waited ${ms}ms`;
    }
    default:
      return action.action;
  }
}

/**
 * Runs the observe -> decide -> act loop until the goal is met, the model
 * gives up, or the step budget runs out. Returns whether the goal was met.
 */
export async function runFlowAgent(options: AgentRunOptions): Promise<boolean> {
  const { page, goal, context, isDone, maxSteps = 8 } = options;
  const history: string[] = [];
  // Repeatedly asking a vision model "should I keep waiting?" costs money
  // and tells us nothing new — one run burned its entire step budget on
  // eight LLM calls that all answered "wait". Consecutive waits are served
  // locally with a longer sleep, and a run that is only ever waiting hands
  // control back to the caller's own polling loop, which does that for free.
  let consecutiveWaits = 0;

  console.log(`flowAgent: taking over — goal: ${goal}`);

  for (let step = 1; step <= maxSteps; step++) {
    if (isDone && (await isDone().catch(() => false))) {
      console.log(`flowAgent: goal satisfied after ${step - 1} step(s)`);
      return true;
    }

    let action: AgentAction;
    try {
      action = await askForNextAction(page, goal, context, history);
    } catch (err) {
      console.error("flowAgent: could not get a usable action from the LLM", err);
      return false;
    }

    console.log(
      `flowAgent step ${step}/${maxSteps}: ${action.action}` +
        (typeof action.agentId === "number" ? ` #${action.agentId}` : "") +
        ` — ${action.reasoning}`
    );

    if (action.action === "done") {
      // Trust but verify: if a completion check exists, it decides.
      const verified = isDone ? await isDone().catch(() => false) : true;
      console.log(`flowAgent: model reported done (verified=${verified})`);
      return verified;
    }
    if (action.action === "fail") {
      console.warn(`flowAgent: model gave up — ${action.reasoning}`);
      return false;
    }

    if (action.action === "wait") {
      consecutiveWaits++;
      if (consecutiveWaits >= 2) {
        console.log(
          `flowAgent: model only wants to wait (${consecutiveWaits}x) — nothing to fix here, returning to the normal polling loop`
        );
        return isDone ? await isDone().catch(() => false) : false;
      }
    } else {
      consecutiveWaits = 0;
    }

    try {
      const outcome = await executeAction(page, action);
      history.push(`step ${step}: ${outcome} — ${action.reasoning}`);
    } catch (err) {
      const message = (err as Error).message.split("\n")[0];
      console.warn(`flowAgent: action failed — ${message}`);
      history.push(`step ${step}: ${action.action} FAILED (${message})`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1200));
  }

  const met = isDone ? await isDone().catch(() => false) : false;
  console.warn(`flowAgent: step budget exhausted (goal met=${met})`);
  return met;
}
