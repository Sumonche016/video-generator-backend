import { Router } from "express";
import { z } from "zod";
import {
  generateCharacterBibleCandidates,
  approveCharacterBible,
  signCharacterCandidates,
  getCharacterBibleWithUrls,
  generateProductBibleCandidates,
  approveProductBible,
  signProductCandidates,
  getProductBibleWithUrls,
} from "../services/bible.service.js";
import { getSignedAssetUrl } from "../storage/assetStorage.js";

export const characterBibleRouter = Router({ mergeParams: true });
export const productBibleRouter = Router({ mergeParams: true });

const generateSchema = z.object({ refinementPrompt: z.string().optional() });
const approveSchema = z.object({ imagePath: z.string().min(1) });

characterBibleRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId, charId } = req.params as { id: string; charId: string };
    res.json(await getCharacterBibleWithUrls(projectId, charId));
  } catch (err) {
    next(err);
  }
});

characterBibleRouter.post("/generate", async (req, res, next) => {
  try {
    const { id: projectId, charId } = req.params as { id: string; charId: string };
    const body = generateSchema.parse(req.body ?? {});
    const character = await generateCharacterBibleCandidates(projectId, charId, body.refinementPrompt);
    res.json(await signCharacterCandidates(character));
  } catch (err) {
    next(err);
  }
});

characterBibleRouter.post("/approve", async (req, res, next) => {
  try {
    const { id: projectId, charId } = req.params as { id: string; charId: string };
    const body = approveSchema.parse(req.body);
    const character = await approveCharacterBible(projectId, charId, body.imagePath);
    const approvedUrl = character.bible.approvedImagePath
      ? await getSignedAssetUrl(character.bible.approvedImagePath)
      : null;
    res.json({ ...character, approvedUrl });
  } catch (err) {
    next(err);
  }
});

productBibleRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await getProductBibleWithUrls(projectId));
  } catch (err) {
    next(err);
  }
});

productBibleRouter.post("/generate", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const body = generateSchema.parse(req.body ?? {});
    const project = await generateProductBibleCandidates(projectId, body.refinementPrompt);
    const candidateUrls = await signProductCandidates(project);
    res.json({ ...project, candidateUrls });
  } catch (err) {
    next(err);
  }
});

productBibleRouter.post("/approve", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const body = approveSchema.parse(req.body);
    const project = await approveProductBible(projectId, body.imagePath);
    const approvedUrl = project.bibles.product.approvedImagePath
      ? await getSignedAssetUrl(project.bibles.product.approvedImagePath)
      : null;
    res.json({ ...project, approvedUrl });
  } catch (err) {
    next(err);
  }
});
