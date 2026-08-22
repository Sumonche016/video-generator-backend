import { Router } from "express";
import { z } from "zod";
import { getMaskedApiKeys, updateApiKey } from "../config/runtimeConfig.js";
import { resetProviders } from "../config/providers.config.js";

// Global settings — not scoped to a project, reachable from anywhere in the
// app (the Settings nav item in the sidebar), so API keys can be rotated
// without editing backend/.env or redeploying.
export const settingsRouter = Router();

settingsRouter.get("/", (_req, res) => {
  res.json({ apiKeys: getMaskedApiKeys() });
});

const updateSchema = z.object({
  openaiApiKey: z.string().min(1).optional(),
  googleApiKey: z.string().min(1).optional(),
});

settingsRouter.patch("/", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body ?? {});
    if (!body.openaiApiKey && !body.googleApiKey) {
      res.status(400).json({ error: "Provide at least one of openaiApiKey or googleApiKey" });
      return;
    }
    if (body.openaiApiKey) await updateApiKey("OPENAI_API_KEY", body.openaiApiKey);
    if (body.googleApiKey) await updateApiKey("GOOGLE_API_KEY", body.googleApiKey);
    resetProviders();
    res.json({ apiKeys: getMaskedApiKeys() });
  } catch (err) {
    next(err);
  }
});
