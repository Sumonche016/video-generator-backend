import { Router } from "express";
import { z } from "zod";
import {
  createProject,
  getProject,
  listProjects,
  deleteProject,
} from "../services/project.service.js";

export const projectsRouter = Router();

const createSchema = z.object({
  name: z.string().min(1),
  dimension: z.literal("YOUTUBE_16_9").optional(),
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const project = await createProject(body.name, body.dimension);
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

projectsRouter.get("/", async (_req, res, next) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteProject(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
