import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { scriptRouter } from "./routes/script.routes.js";
import { charactersRouter } from "./routes/characters.routes.js";
import { characterBibleRouter, productBibleRouter } from "./routes/bibles.routes.js";
import { lockRouter } from "./routes/lock.routes.js";
import { voiceoverRouter } from "./routes/voiceover.routes.js";
import { blocksRouter } from "./routes/blocks.routes.js";
import { clipsRouter } from "./routes/clips.routes.js";
import { assembleRouter } from "./routes/assemble.routes.js";
import { finalRouter } from "./routes/final.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";
import { promptsRouter } from "./routes/prompts.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);

  app.use("/api", requireAuth);

  app.use("/api/projects", projectsRouter);
  app.use("/api/projects/:id/product", productRouter);
  app.use("/api/projects/:id/script", scriptRouter);
  app.use("/api/projects/:id/characters", charactersRouter);
  app.use("/api/projects/:id/characters/:charId/bible", characterBibleRouter);
  app.use("/api/projects/:id/product-bible", productBibleRouter);
  app.use("/api/projects/:id/lock", lockRouter);
  app.use("/api/projects/:id/voiceover", voiceoverRouter);
  app.use("/api/projects/:id/blocks", blocksRouter);
  app.use("/api/projects/:id/blocks", clipsRouter);
  app.use("/api/projects/:id/assemble", assembleRouter);
  app.use("/api/projects/:id/final", finalRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/prompts", promptsRouter);

  app.use(errorHandler);
  return app;
}
