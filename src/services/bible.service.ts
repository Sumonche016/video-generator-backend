import { getImageGenProvider } from "../config/providers.config.js";
import { supabase } from "../storage/supabaseClient.js";
import { assetPaths, uploadAsset, getSignedAssetUrl, copyAsset, downloadAsset } from "../storage/assetStorage.js";
import { getProject, saveProject } from "./project.service.js";
import { buildCharacterBiblePrompt, buildProductBiblePrompt } from "../prompt-templates/bibleGeneration.template.js";
import type { BibleAsset, Character } from "../models/index.js";

// Generating multiple candidates per bible costs money for images that get
// thrown away the moment one is picked — one high-quality generation per
// bible avoids that waste (see prompt-templates/bibleGeneration.template.ts
// for the detailed, quality-focused prompt this relies on instead).
const CANDIDATE_COUNT = 1;

interface CharacterRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  source: "ai" | "human-added";
  approved: boolean;
  bible: BibleAsset;
}

function mapCharacterRow(row: CharacterRow): Character {
  return { ...row };
}

async function getCharacterRow(projectId: string, characterId: string): Promise<CharacterRow> {
  const { data, error } = await supabase
    .from("characters")
    .select()
    .eq("project_id", projectId)
    .eq("id", characterId)
    .single();
  if (error) throw error;
  return data as CharacterRow;
}

export async function generateCharacterBibleCandidates(
  projectId: string,
  characterId: string,
  refinementPrompt?: string
): Promise<Character> {
  const character = await getCharacterRow(projectId, characterId);
  const prompt = buildCharacterBiblePrompt(character.name, character.description, refinementPrompt);

  const imageGen = getImageGenProvider();
  const { images } = await imageGen.generate({ prompt, n: CANDIDATE_COUNT });

  const candidatePaths: string[] = [];
  for (const [i, buffer] of images.entries()) {
    const objectKey = assetPaths.characterBible(projectId, character.slug, `candidate-${Date.now()}-${i}.png`);
    await uploadAsset(objectKey, buffer, "image/png");
    candidatePaths.push(objectKey);
  }

  const bible: BibleAsset = {
    candidatePaths,
    refinementPrompts: [...character.bible.refinementPrompts, ...(refinementPrompt ? [refinementPrompt] : [])],
    approvedImagePath: character.bible.approvedImagePath,
    status: "generating",
  };

  const { data, error } = await supabase
    .from("characters")
    .update({ bible })
    .eq("id", characterId)
    .eq("project_id", projectId)
    .select()
    .single();
  if (error) throw error;
  return mapCharacterRow(data as CharacterRow);
}

// Lets the user upload their own photo instead of generating one with AI —
// added as a candidate exactly like a generated one, so the existing
// approve flow (pick a candidatePaths entry) works unchanged.
export async function uploadCharacterBibleCandidate(
  projectId: string,
  characterId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string }
): Promise<Character> {
  const character = await getCharacterRow(projectId, characterId);
  const ext = file.originalname.includes(".") ? file.originalname.split(".").pop() : "png";
  const objectKey = assetPaths.characterBible(projectId, character.slug, `uploaded-${Date.now()}.${ext}`);
  await uploadAsset(objectKey, file.buffer, file.mimetype);

  const bible: BibleAsset = {
    ...character.bible,
    candidatePaths: [...character.bible.candidatePaths, objectKey],
    status: "generating",
  };

  const { data, error } = await supabase
    .from("characters")
    .update({ bible })
    .eq("id", characterId)
    .eq("project_id", projectId)
    .select()
    .single();
  if (error) throw error;
  return mapCharacterRow(data as CharacterRow);
}

export async function approveCharacterBible(
  projectId: string,
  characterId: string,
  chosenImagePath: string
): Promise<Character> {
  const character = await getCharacterRow(projectId, characterId);
  if (!character.bible.candidatePaths.includes(chosenImagePath)) {
    throw new Error("Chosen image is not one of this character's candidates");
  }

  const finalKey = assetPaths.characterBible(projectId, character.slug, `${character.name.replace(/\s+/g, "")}.png`);
  await copyAsset(chosenImagePath, finalKey);

  const bible: BibleAsset = { ...character.bible, approvedImagePath: finalKey, status: "approved" };
  const { data, error } = await supabase
    .from("characters")
    .update({ bible })
    .eq("id", characterId)
    .eq("project_id", projectId)
    .select()
    .single();
  if (error) throw error;
  return mapCharacterRow(data as CharacterRow);
}

export async function signCharacterCandidates(character: Character): Promise<Character & { candidateUrls: string[] }> {
  const candidateUrls = await Promise.all(character.bible.candidatePaths.map((p) => getSignedAssetUrl(p)));
  return { ...character, candidateUrls };
}

export async function getCharacterBibleWithUrls(projectId: string, characterId: string) {
  const character = mapCharacterRow(await getCharacterRow(projectId, characterId));
  const candidateUrls = await Promise.all(character.bible.candidatePaths.map((p) => getSignedAssetUrl(p)));
  const approvedUrl = character.bible.approvedImagePath
    ? await getSignedAssetUrl(character.bible.approvedImagePath)
    : null;
  return { ...character, candidateUrls, approvedUrl };
}

// --- Product bible (single product per project for v1) ---

export async function generateProductBibleCandidates(projectId: string, refinementPrompt?: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");

  if (project.product.imagePaths.length === 0) {
    throw new Error("No uploaded product image to base the bible on — go back to Product Upload first.");
  }

  const prompt = buildProductBiblePrompt(project.product.understandingSummary, refinementPrompt);
  const referenceImages = await Promise.all(
    project.product.imagePaths.map(async (key) => {
      const { buffer, mimeType } = await downloadAsset(key);
      return { buffer, mimeType };
    })
  );

  const imageGen = getImageGenProvider();
  const { images } = await imageGen.generate({ prompt, referenceImages, n: CANDIDATE_COUNT });

  const candidatePaths: string[] = [];
  for (const [i, buffer] of images.entries()) {
    const objectKey = assetPaths.productBible(projectId, `candidate-${Date.now()}-${i}.png`);
    await uploadAsset(objectKey, buffer, "image/png");
    candidatePaths.push(objectKey);
  }

  project.bibles.product = {
    candidatePaths,
    refinementPrompts: [
      ...project.bibles.product.refinementPrompts,
      ...(refinementPrompt ? [refinementPrompt] : []),
    ],
    approvedImagePath: project.bibles.product.approvedImagePath,
    status: "generating",
  };
  return saveProject(project);
}

export async function approveProductBible(projectId: string, chosenImagePath: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.bibles.product.candidatePaths.includes(chosenImagePath)) {
    throw new Error("Chosen image is not one of the product's candidates");
  }

  const finalKey = assetPaths.productBible(projectId, "ProductBible.png");
  await copyAsset(chosenImagePath, finalKey);

  project.bibles.product = { ...project.bibles.product, approvedImagePath: finalKey, status: "approved" };
  return saveProject(project);
}

export async function signProductCandidates(project: { bibles: { product: BibleAsset } }) {
  const candidateUrls = await Promise.all(
    project.bibles.product.candidatePaths.map((p) => getSignedAssetUrl(p))
  );
  return candidateUrls;
}

export async function getProductBibleWithUrls(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const candidateUrls = await signProductCandidates(project);
  const approvedUrl = project.bibles.product.approvedImagePath
    ? await getSignedAssetUrl(project.bibles.product.approvedImagePath)
    : null;
  return { ...project, candidateUrls, approvedUrl };
}
