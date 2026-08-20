import { Router } from "express";
import { z } from "zod";
import {
  listCharacters,
  addCharacter,
  setCharacterApproval,
  confirmApprovedCharacters,
} from "../services/script.service.js";

export const charactersRouter = Router({ mergeParams: true });

charactersRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await listCharacters(projectId));
  } catch (err) {
    next(err);
  }
});

const addSchema = z.object({ name: z.string().min(1), description: z.string().default("") });

charactersRouter.post("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const body = addSchema.parse(req.body);
    res.status(201).json(await addCharacter(projectId, body.name, body.description));
  } catch (err) {
    next(err);
  }
});

const approveSchema = z.object({ approved: z.boolean() });

charactersRouter.patch("/:charId", async (req, res, next) => {
  try {
    const { id: projectId, charId } = req.params as { id: string; charId: string };
    const body = approveSchema.parse(req.body);
    res.json(await setCharacterApproval(projectId, charId, body.approved));
  } catch (err) {
    next(err);
  }
});

charactersRouter.post("/confirm", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await confirmApprovedCharacters(projectId));
  } catch (err) {
    next(err);
  }
});
