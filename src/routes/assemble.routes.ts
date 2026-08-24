import { Router } from "express";
import { assembleProject, getFinalVideoUrl } from "../services/assemble.service.js";
import { getProject } from "../services/project.service.js";

export const assembleRouter = Router({ mergeParams: true });

assembleRouter.post("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const { burnSubtitles, subtitleStyle } = req.body ?? {};
    const { project, skippedBlockIndices } = await assembleProject(projectId, { burnSubtitles, subtitleStyle });
    res.json({ ...project, skippedBlockIndices });
  } catch (err) {
    next(err);
  }
});

assembleRouter.get("/status", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ stage: project.stage, finalOutputPath: project.finalOutputPath });
  } catch (err) {
    next(err);
  }
});
