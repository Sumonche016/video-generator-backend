import { Router } from "express";
import { z } from "zod";
import { getMaskedApiKeys, updateApiKey, updateVideoGenProvider, runtimeConfig } from "../config/runtimeConfig.js";
import { resetProviders } from "../config/providers.config.js";

// Global settings — not scoped to a project, reachable from anywhere in the
// app (the Settings nav item in the sidebar), so API keys can be rotated
// without editing backend/.env or redeploying.
export const settingsRouter = Router();

settingsRouter.get("/", (_req, res) => {
  res.json({ apiKeys: getMaskedApiKeys(), videoProvider: runtimeConfig.VIDEOGEN_PROVIDER });
});

const updateSchema = z.object({
  openaiApiKey: z.string().min(1).optional(),
  googleApiKey: z.string().min(1).optional(),
  openrouterApiKey: z.string().min(1).optional(),
  videoProvider: z.enum(["veo", "wan", "omni"]).optional(),
});

settingsRouter.patch("/", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body ?? {});
    if (!body.openaiApiKey && !body.googleApiKey && !body.openrouterApiKey && !body.videoProvider) {
      res.status(400).json({
        error: "Provide at least one of openaiApiKey, googleApiKey, openrouterApiKey, or videoProvider",
      });
      return;
    }
    if (body.openaiApiKey) await updateApiKey("OPENAI_API_KEY", body.openaiApiKey);
    if (body.googleApiKey) await updateApiKey("GOOGLE_API_KEY", body.googleApiKey);
    if (body.openrouterApiKey) await updateApiKey("OPENROUTER_API_KEY", body.openrouterApiKey);
    if (body.videoProvider) await updateVideoGenProvider(body.videoProvider);
    resetProviders();
    res.json({ apiKeys: getMaskedApiKeys(), videoProvider: runtimeConfig.VIDEOGEN_PROVIDER });
  } catch (err) {
    next(err);
  }
});
