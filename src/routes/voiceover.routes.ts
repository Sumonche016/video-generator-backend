import { Router } from "express";
import { upload } from "../middleware/upload.js";
import { uploadVoiceover } from "../services/voiceover.service.js";
import { getProject } from "../services/project.service.js";

export const voiceoverRouter = Router({ mergeParams: true });

voiceoverRouter.post(
  "/",
  upload.fields([{ name: "mp3", maxCount: 1 }, { name: "transcript", maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const { id: projectId } = req.params as { id: string };
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const mp3File = files?.mp3?.[0];
      const transcriptFile = files?.transcript?.[0];
      if (!mp3File || !transcriptFile) {
        res.status(400).json({ error: "Both 'mp3' and 'transcript' files are required" });
        return;
      }

      let transcriptJson: unknown;
      try {
        transcriptJson = JSON.parse(transcriptFile.buffer.toString("utf-8"));
      } catch {
        res.status(400).json({ error: "transcript file is not valid JSON" });
        return;
      }

      const project = await uploadVoiceover({
        projectId,
        mp3: { buffer: mp3File.buffer, mimetype: mp3File.mimetype },
        transcriptJson,
      });
      res.json(project);
    } catch (err) {
      next(err);
    }
  }
);

voiceoverRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project.voiceover);
  } catch (err) {
    next(err);
  }
});
