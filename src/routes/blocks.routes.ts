import { Router } from "express";
import { z } from "zod";
import { upload } from "../middleware/upload.js";
import {
  splitIntoBlocksAndSave,
  generateNextPromptBatch,
  listBlocks,
  getBlock,
  updateBlock,
  approveBlockPrompt,
  approveAllPrompts,
  addBlockReferenceImage,
} from "../services/block.service.js";

export const blocksRouter = Router({ mergeParams: true });

blocksRouter.post("/plan", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await splitIntoBlocksAndSave(projectId));
  } catch (err) {
    next(err);
  }
});

// Generates prompts for every not-yet-planned block in one call (text-only,
// fast) — unlike Veo clip generation, which is intentionally batched
// 5-at-a-time since each video takes a long time.
blocksRouter.post("/generate-prompts", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await generateNextPromptBatch(projectId));
  } catch (err) {
    next(err);
  }
});

blocksRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await listBlocks(projectId));
  } catch (err) {
    next(err);
  }
});

blocksRouter.get("/:index", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    res.json(await getBlock(projectId, Number(index)));
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  veoPrompt: z.string().optional(),
  attachedReferenceNames: z.array(z.string()).optional(),
});

blocksRouter.patch("/:index", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const body = patchSchema.parse(req.body);
    res.json(await updateBlock(projectId, Number(index), body));
  } catch (err) {
    next(err);
  }
});

blocksRouter.post("/:index/approve-prompt", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    res.json(await approveBlockPrompt(projectId, Number(index)));
  } catch (err) {
    next(err);
  }
});

blocksRouter.post("/:index/reference-image", upload.single("image"), async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "'image' file is required" });
      return;
    }
    const block = await addBlockReferenceImage(projectId, Number(index), {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    res.json(block);
  } catch (err) {
    next(err);
  }
});

blocksRouter.post("/approve-all-prompts", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    res.json(await approveAllPrompts(projectId));
  } catch (err) {
    next(err);
  }
});
