import { supabase } from "./supabaseClient.js";
import { env } from "../config/env.js";

// Mirrors the old local-filesystem folder layout, but as Supabase Storage
// object keys within the single `project-assets` bucket.
export const assetPaths = {
  product: (projectId: string, filename: string) => `${projectId}/product/${filename}`,
  characterBible: (projectId: string, slug: string, filename: string) =>
    `${projectId}/bibles/characters/${slug}/${filename}`,
  productBible: (projectId: string, filename: string) => `${projectId}/bibles/product/${filename}`,
  customReference: (projectId: string, name: string, filename: string) =>
    `${projectId}/bibles/custom/${name}/${filename}`,
  voiceover: (projectId: string, filename: string) => `${projectId}/voiceover/${filename}`,
  blockClip: (projectId: string, blockIndex: number, filename: string) =>
    `${projectId}/blocks/clips/block-${blockIndex}/${filename}`,
  final: (projectId: string, filename: string) => `${projectId}/final/${filename}`,
  preview: (projectId: string, filename: string) => `${projectId}/previews/${filename}`,
};

export async function uploadAsset(
  objectKey: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  const { error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(objectKey, data, { contentType, upsert: true });
  if (error) throw error;
  return objectKey;
}

export async function downloadAsset(objectKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data, error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).download(objectKey);
  if (error) throw error;
  return { buffer: Buffer.from(await data.arrayBuffer()), mimeType: data.type || "image/png" };
}

export async function getSignedAssetUrl(objectKey: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(objectKey, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

// Supabase Storage's `list` is not recursive, so we walk the tree
// ourselves. Entries with no `id` are treated as sub-"folders" (Supabase
// Storage has no real directories, just key prefixes).
async function collectFilePaths(prefix: string): Promise<string[]> {
  const { data: entries, error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .list(prefix, { limit: 1000 });
  if (error) throw error;
  if (!entries || entries.length === 0) return [];

  const filePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = `${prefix}/${entry.name}`;
    if (entry.id) {
      filePaths.push(entryPath);
    } else {
      filePaths.push(...(await collectFilePaths(entryPath)));
    }
  }
  return filePaths;
}

// Re-approving a bible must overwrite the previous <Name>.png. Supabase
// Storage's `copy` refuses if the destination already exists, so we
// download+re-upload (upsert: true) instead of using copy().
export async function copyAsset(fromKey: string, toKey: string): Promise<void> {
  const { data, error: downloadError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .download(fromKey);
  if (downloadError) throw downloadError;
  const buffer = Buffer.from(await data.arrayBuffer());
  await uploadAsset(toKey, buffer, data.type || "image/png");
}

export async function deleteAssetPrefix(prefix: string): Promise<void> {
  const filePaths = await collectFilePaths(prefix);
  if (filePaths.length === 0) return;
  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove(filePaths);
  if (error) throw error;
}
