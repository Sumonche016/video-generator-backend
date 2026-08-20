import { Router } from "express";
import { z } from "zod";
import { uploadScriptAndExtractCharacters } from "../services/script.service.js";
import { getProject } from "../services/project.service.js";

export const scriptRouter = Router({ mergeParams: true });

const scriptSchema = z.object({ text: z.string().min(1) });

scriptRouter.post("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const body = scriptSchema.parse(req.body);
    const result = await uploadScriptAndExtractCharacters(projectId, body.text);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

scriptRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project.script);
  } catch (err) {
    next(err);
  }
});
