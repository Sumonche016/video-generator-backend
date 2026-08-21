import { Router } from "express";
import { lockProject, getLockedManifestWithUrls } from "../services/lock.service.js";

export const lockRouter = Router({ mergeParams: true });

lockRouter.post("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const project = await lockProject(projectId);
    res.json(project);
  } catch (err) {
    next(err);
  }
});

lockRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await getLockedManifestWithUrls(projectId));
  } catch (err) {
    next(err);
  }
});
