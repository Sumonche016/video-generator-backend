import { Router } from "express";
import { z } from "zod";
import {
  generateNextBatch,
  pollClipStatus,
  approveClip,
  rejectClip,
  applyDucking,
  generateGapFiller,
  pollGapFillerStatus,
  approveGapFiller,
} from "../services/clip.service.js";
import { mergePreviewClips } from "../services/assemble.service.js";
import { getSignedAssetUrl } from "../storage/assetStorage.js";

export const clipsRouter = Router({ mergeParams: true });

const generateBatchSchema = z.object({
  count: z.number().int().min(1).optional(),
  indices: z.array(z.number().int().min(0)).optional(),
});

clipsRouter.post("/generate-batch", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const body = generateBatchSchema.parse(req.body ?? {});
    res.json(await generateNextBatch(projectId, { count: body.count, indices: body.indices }));
  } catch (err) {
    next(err);
  }
});

clipsRouter.post("/merge-preview", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const { burnSubtitles, subtitleStyle } = req.body ?? {};
    res.json(await mergePreviewClips(projectId, { burnSubtitles, subtitleStyle }));
  } catch (err) {
    next(err);
  }
});

clipsRouter.get("/:index/clip-status", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const block = await pollClipStatus(projectId, Number(index));
    const latest = block.clipAttempts[block.clipAttempts.length - 1];
    const clipUrl = latest?.status === "succeeded" ? await getSignedAssetUrl(latest.path) : null;
    res.json({ ...block, clipUrl });
  } catch (err) {
    next(err);
  }
});

clipsRouter.post("/:index/clip/approve", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    res.json(await approveClip(projectId, Number(index)));
  } catch (err) {
    next(err);
  }
});

const rejectSchema = z.object({ newPrompt: z.string().optional() });

clipsRouter.post("/:index/clip/reject", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const body = rejectSchema.parse(req.body ?? {});
    res.json(await rejectClip(projectId, Number(index), body.newPrompt));
  } catch (err) {
    next(err);
  }
});

const gapFillerSchema = z.object({ prompt: z.string().min(1) });

clipsRouter.post("/:index/gap-filler", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const body = gapFillerSchema.parse(req.body ?? {});
    res.json(await generateGapFiller(projectId, Number(index), body.prompt));
  } catch (err) {
    next(err);
  }
});

clipsRouter.get("/:index/gap-filler-status", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const block = await pollGapFillerStatus(projectId, Number(index));
    const latest = block.gapFillerAttempts?.[block.gapFillerAttempts.length - 1];
    const gapFillerUrl = latest?.status === "succeeded" ? await getSignedAssetUrl(latest.path) : null;
    res.json({ ...block, gapFillerUrl });
  } catch (err) {
    next(err);
  }
});

clipsRouter.post("/:index/gap-filler/approve", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    res.json(await approveGapFiller(projectId, Number(index)));
  } catch (err) {
    next(err);
  }
});

const audioLevelSchema = z.object({ duckingFactor: z.number().min(0).max(1) });

clipsRouter.post("/:index/audio-level", async (req, res, next) => {
  try {
    const { id: projectId, index } = req.params as { id: string; index: string };
    const body = audioLevelSchema.parse(req.body);
    res.json(await applyDucking(projectId, Number(index), body.duckingFactor));
  } catch (err) {
    next(err);
  }
});
