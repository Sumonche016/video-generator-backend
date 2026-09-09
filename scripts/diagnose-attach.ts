// Temporary diagnostic: drives Flow up to (not through) the attach step and
// records exactly what the panel does at each click, so the attach bug can
// be observed directly instead of inferred from selectors that "should" work.
// Stops before submitting any prompt — no generation, no credits used.
import "dotenv/config";
import { mkdir, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getFlowBrowserPage } from "../src/providers/video/goLoginClient.js";
import { getFlowProfileIds } from "../src/providers/video/goLoginProfilePool.js";

const OUT = path.resolve("debug-screenshots/diag");
const FLOW_URL = "https://labs.google/fx/tools/flow";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: any, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled", timeout: 15000 })
    .catch((e: Error) => console.log(`  [shot ${name} failed: ${e.message.split("\n")[0]}]`));
}

async function report(page: any, label: string) {
  const state = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll("span.asset-title")).map((e) => (e.textContent ?? "").trim());
    const rows = Array.from(document.querySelectorAll("button.asset-item")).map((el) => ({
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 45),
      cls: el.className,
      ariaSelected: el.getAttribute("aria-selected"),
    }));
    const bar = document.querySelector("span.selection-bar-count");
    const btn = document.querySelector("button.detail-add-to-prompt-btn");
    const uploading = document.querySelectorAll(".cdk-visually-hidden");
    return {
      titles,
      rows,
      selectionBar: bar ? (bar.textContent ?? "").trim() : null,
      addBtn: btn ? { label: (btn.textContent ?? "").trim(), disabled: btn.hasAttribute("disabled") } : null,
      uploadingMarkers: Array.from(uploading).map((e) => (e.textContent ?? "").trim()).filter(Boolean),
    };
  }).catch((e: Error) => ({ error: e.message }));
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(state, null, 2));
  await shot(page, label);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Two real PNGs with the same names the real run uses.
  const tmpDir = path.join(os.tmpdir(), `diag-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const src = path.resolve("debug-screenshots");
  const files = [path.join(tmpDir, "MarcusThorne.png"), path.join(tmpDir, "DavidChen.png")];
  await copyFile(path.join(src, "attach-panel-after-upload-1788542237690.png"), files[0]);
  await copyFile(path.join(src, "add-to-prompt-never-clicked-1788542239621.png"), files[1]);
  console.log("test files:", files);

  const { page, close } = await getFlowBrowserPage(getFlowProfileIds()[0]);
  try {
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
    await pause(6000);
    console.log("landed on:", page.url());

    if (!/\/project\//.test(page.url())) {
      await page.getByText("New project", { exact: true }).first().click({ timeout: 15000 });
      await page.waitForURL(/\/project\//, { timeout: 30000 });
      await pause(5000);
    }
    console.log("project:", page.url());
    await report(page, "01-project-open");

    // Open the attach panel via the "+" left of the Agent pill.
    await page.getByText("Agent", { exact: true }).locator("xpath=preceding::button[1]").click({ timeout: 10000 });
    await pause(2500);
    await report(page, "02-panel-open");

    // Upload both files at once.
    const chooserPromise = page.waitForEvent("filechooser");
    chooserPromise.catch(() => {});
    await page.getByRole("button", { name: "Upload media" }).first().click({ timeout: 10000 });
    const chooser = await chooserPromise;
    console.log("file chooser multiple?", chooser.isMultiple());
    await chooser.setFiles(files);
    console.log("setFiles done");

    // Watch the upload settle.
    for (let i = 0; i < 12; i++) {
      await pause(3000);
      const markers = await page.locator(".cdk-visually-hidden").allTextContents().catch(() => []);
      const uploading = markers.filter((m: string) => /uploading/i.test(m));
      const titles = await page.locator("span.asset-title").allTextContents().catch(() => []);
      console.log(`poll ${i}: uploading=${uploading.length} titles=[${titles.join(" | ")}]`);
      if (uploading.length === 0 && titles.length >= 2) break;
    }
    await report(page, "03-after-upload");

    const rowFor = (name: string) => page.locator("button.asset-item").filter({ hasText: name }).first();
    const count = async () => {
      const t = await page.locator("span.selection-bar-count").first().textContent().catch(() => null);
      return t ? Number(t.match(/(\d+)/)?.[1] ?? 0) : 0;
    };

    console.log("\n== selection experiment ==");
    console.log("count before:", await count());

    await rowFor("MarcusThorne.png").click({ modifiers: ["Control"], timeout: 10000 }).catch((e: Error) => console.log("click1 err:", e.message.split("\n")[0]));
    await pause(2000);
    console.log("after CTRL click MarcusThorne -> count:", await count());
    await report(page, "04-after-ctrl-click-1");

    await rowFor("DavidChen.png").click({ modifiers: ["Control"], timeout: 10000 }).catch((e: Error) => console.log("click2 err:", e.message.split("\n")[0]));
    await pause(2000);
    console.log("after CTRL click DavidChen -> count:", await count());
    await report(page, "05-after-ctrl-click-2");

    console.log("\nDONE — leaving the panel as-is, nothing attached, nothing generated.");
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("diag failed:", e);
  process.exit(1);
});
