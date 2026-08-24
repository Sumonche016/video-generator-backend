import { getLLMProvider } from "../config/providers.config.js";
import { getPrompt } from "../config/promptRegistry.js";
import { assetPaths, uploadAsset, getSignedAssetUrl } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage } from "./project.service.js";
import { buildProductUnderstandingUserMessage } from "../prompt-templates/productUnderstanding.template.js";
import { extractUrls, fetchPageText } from "./pageFetch.service.js";
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

  // If the user pasted a landing page URL in the info text, fetch its page
  // text server-side and hand that to the LLM too, since the LLM itself
  // can't browse links on its own.
  const pageUrls = extractUrls(input.infoText);
  const pages = await Promise.all(pageUrls.map(async (url) => ({ url, text: await fetchPageText(url) })));
  const fetchedPages = pages.filter((p): p is { url: string; text: string } => !!p.text);
  const infoTextWithPages = fetchedPages.length
    ? `${input.infoText}\n\n${fetchedPages.map((p) => `Landing page content from ${p.url}:\n${p.text}`).join("\n\n")}`
    : input.infoText;

  const llm = getLLMProvider();
  const result = await llm.chat({
    systemPrompt: getPrompt("PRODUCT_UNDERSTANDING_SYSTEM_PROMPT"),
    messages: [
      {
        role: "user",
        content: buildProductUnderstandingUserMessage(infoTextWithPages),
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
