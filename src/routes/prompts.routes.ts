import { Router } from "express";
import { z } from "zod";
import { listPromptEntries, updatePromptOverride, resetPromptOverride, PROMPT_DEFAULTS } from "../config/promptRegistry.js";
import type { PromptKey } from "../config/promptRegistry.js";

// Global — not scoped to a project, reachable from anywhere in the app (the
// central Prompts page + per-step panels), so prompt text can be viewed and
// edited without touching backend code/redeploying.
export const promptsRouter = Router();

function isPromptKey(key: string): key is PromptKey {
  return key in PROMPT_DEFAULTS;
}

promptsRouter.get("/", (_req, res) => {
  res.json({ prompts: listPromptEntries() });
});

const updateSchema = z.object({ text: z.string().min(1) });

promptsRouter.patch("/:key", async (req, res, next) => {
  try {
    const { key } = req.params as { key: string };
    if (!isPromptKey(key)) {
      res.status(404).json({ error: `Unknown prompt key: ${key}` });
      return;
    }
    const body = updateSchema.parse(req.body ?? {});
    await updatePromptOverride(key, body.text);
    res.json({ prompts: listPromptEntries() });
  } catch (err) {
    next(err);
  }
});

promptsRouter.post("/:key/reset", async (req, res, next) => {
  try {
    const { key } = req.params as { key: string };
    if (!isPromptKey(key)) {
      res.status(404).json({ error: `Unknown prompt key: ${key}` });
      return;
    }
    await resetPromptOverride(key);
    res.json({ prompts: listPromptEntries() });
  } catch (err) {
    next(err);
  }
});
