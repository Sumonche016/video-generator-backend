import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { scriptRouter } from "./routes/script.routes.js";
import { charactersRouter } from "./routes/characters.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/projects", projectsRouter);
  app.use("/api/projects/:id/product", productRouter);
  app.use("/api/projects/:id/script", scriptRouter);
  app.use("/api/projects/:id/characters", charactersRouter);

  app.use(errorHandler);
  return app;
}
