import { getSignedAssetUrl } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage } from "./project.service.js";
import { listCharacters } from "./script.service.js";
import type { LockedRef, Project } from "../models/index.js";

export class LockValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot lock project: ${issues.join("; ")}`);
    this.name = "LockValidationError";
  }
}

export async function lockProject(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");

  const characters = await listCharacters(projectId);
  const approvedCharacters = characters.filter((c) => c.approved);

  const issues: string[] = [];
  if (approvedCharacters.length === 0) {
    issues.push("No approved characters");
  }
  for (const c of approvedCharacters) {
    if (c.bible.status !== "approved" || !c.bible.approvedImagePath) {
      issues.push(`"${c.name}"'s character bible is not approved yet`);
    }
  }
  if (project.bibles.product.status !== "approved" || !project.bibles.product.approvedImagePath) {
    issues.push("Product bible is not approved yet");
  }

  if (issues.length > 0) {
    throw new LockValidationError(issues);
  }

  const lockedManifest: LockedRef[] = [
    ...approvedCharacters.map((c) => ({
      name: c.name.replace(/\s+/g, ""),
      kind: "character" as const,
      imagePath: c.bible.approvedImagePath as string,
    })),
    {
      name: "ProductBible",
      kind: "product" as const,
      imagePath: project.bibles.product.approvedImagePath as string,
    },
  ];

  project.lockedManifest = lockedManifest;
  advanceStage(project, "LOCKED");
  return saveProject(project);
}

export async function getLockedManifestWithUrls(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.lockedManifest) return { locked: false, manifest: [] };

  const manifest = await Promise.all(
    project.lockedManifest.map(async (ref) => ({
      ...ref,
      url: await getSignedAssetUrl(ref.imagePath),
    }))
  );
  return { locked: true, manifest };
}
