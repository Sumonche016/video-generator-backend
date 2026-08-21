import { Router } from "express";
import { getFinalVideoUrl } from "../services/assemble.service.js";

export const finalRouter = Router({ mergeParams: true });

finalRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const url = await getFinalVideoUrl(projectId);
    if (!url) {
      res.status(404).json({ error: "No final video assembled yet" });
      return;
    }
    res.json({ url });
  } catch (err) {
    next(err);
  }
});
