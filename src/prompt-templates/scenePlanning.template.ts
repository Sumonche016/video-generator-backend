import type { LockedRef } from "../models/index.js";
import { assignCharacterTags } from "./characterTags.js";

// The system prompt itself now lives in config/promptRegistry.ts
// (SCENE_PLANNING_SYSTEM_PROMPT), editable from the web app.
export function buildScenePlanningUserMessage(params: {
  blocks: { blockTranscriptText: string; blockStartSec: number; blockEndSec: number }[];
  fullScriptText: string;
  lockedManifest: LockedRef[];
}): string {
  const tags = assignCharacterTags(params.lockedManifest);
  const manifestList = params.lockedManifest
    .map((r) => (r.kind === "character" ? `${r.name} = ${tags.get(r.name)}` : `${r.name} (product, no tag needed)`))
    .join(", ");

  const blocksList = params.blocks
    .map((b, i) => {
      const gapNote = b.blockTranscriptText
        ? ""
        : " (no narration in this segment — describe an ambient/cutaway visual that fits the surrounding scenes)";
      return `Block ${i} (${b.blockStartSec}s-${b.blockEndSec}s): "${b.blockTranscriptText}"${gapNote}`;
    })
    .join("\n");

  return `Full script (for context):\n${params.fullScriptText}

Locked reference images available (use the exact tag shown for any character that appears in
a scene): ${manifestList}

Plan the following ${params.blocks.length} consecutive blocks, in order:
${blocksList}`;
}

export interface ScenePlanningResult {
  sceneDescription: string;
  suggestedReferenceNames: string[];
}

export function parseScenePlanningBatchResponse(text: string, expectedCount: number): ScenePlanningResult[] {
  const parsed = JSON.parse(text) as { blocks?: unknown };
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];

  const results: ScenePlanningResult[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const entry = blocks[i] as Partial<ScenePlanningResult> | undefined;
    results.push({
      sceneDescription: typeof entry?.sceneDescription === "string" ? entry.sceneDescription : "",
      suggestedReferenceNames: Array.isArray(entry?.suggestedReferenceNames)
        ? entry.suggestedReferenceNames.filter((n): n is string => typeof n === "string")
        : [],
    });
  }
  return results;
}
