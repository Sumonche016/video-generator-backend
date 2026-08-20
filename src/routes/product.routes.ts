import { Router } from "express";
import { upload } from "../middleware/upload.js";
import { uploadAndUnderstandProduct } from "../services/product.service.js";
import { getProject } from "../services/project.service.js";

export const productRouter = Router({ mergeParams: true });

productRouter.post("/", upload.array("images", 8), async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const infoText = typeof req.body.infoText === "string" ? req.body.infoText : "";
    const files = (req.files as Express.Multer.File[]) ?? [];
    const project = await uploadAndUnderstandProduct({
      projectId,
      infoText,
      images: files.map((f) => ({ originalname: f.originalname, buffer: f.buffer, mimetype: f.mimetype })),
    });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

productRouter.get("/", async (req, res, next) => {
  try {
    const { id: projectId } = req.params as { id: string };
    const project = await getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project.product);
  } catch (err) {
    next(err);
  }
});
