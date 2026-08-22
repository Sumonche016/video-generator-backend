import { getLLMProvider } from "../config/providers.config.js";
import { getPrompt } from "../config/promptRegistry.js";
import { assetPaths, uploadAsset, getSignedAssetUrl } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage } from "./project.service.js";
import { buildProductUnderstandingUserMessage } from "../prompt-templates/productUnderstanding.template.js";
import type { Project } from "../models/index.js";

export interface ProductUploadInput {
  projectId: string;
  infoText: string;
  images: { originalname: string; buffer: Buffer; mimetype: string }[];
}

export async function uploadAndUnderstandProduct(input: ProductUploadInput): Promise<Project> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Project not found");

  const imagePaths: string[] = [];
  for (const [i, image] of input.images.entries()) {
    const objectKey = assetPaths.product(input.projectId, `${i}-${image.originalname}`);
    await uploadAsset(objectKey, image.buffer, image.mimetype);
    imagePaths.push(objectKey);
  }

  const signedUrls = await Promise.all(imagePaths.map((p) => getSignedAssetUrl(p)));

  const llm = getLLMProvider();
  const result = await llm.chat({
    systemPrompt: getPrompt("PRODUCT_UNDERSTANDING_SYSTEM_PROMPT"),
    messages: [
      {
        role: "user",
        content: buildProductUnderstandingUserMessage(input.infoText),
        images: signedUrls.map((url) => ({ url })),
      },
    ],
  });

  project.product = {
    imagePaths,
    infoText: input.infoText,
    understandingSummary: result.text.trim(),
    status: "understood",
  };
  advanceStage(project, "PRODUCT_UNDERSTOOD");
  return saveProject(project);
}

export async function updateProductSummary(projectId: string, understandingSummary: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.product = { ...project.product, understandingSummary, status: "understood" };
  return saveProject(project);
}
