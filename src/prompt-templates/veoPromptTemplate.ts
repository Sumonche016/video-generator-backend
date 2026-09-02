import type { LockedRef, VideoDimension } from "../models/index.js";
import { getNoSpokenWordsRule } from "./rules/noSpokenWords.rule.js";
import { buildReferenceMappingRule } from "./rules/referenceMapping.rule.js";
import { getIdentityDiversityRule } from "./rules/identityDiversity.rule.js";
import { buildSingleProductInstanceRule } from "./rules/singleProductInstance.rule.js";
import { getPhysicalRealismRule } from "./rules/physicalRealism.rule.js";
import { getNoStaticOpeningRule } from "./rules/noStaticOpening.rule.js";

export interface BuildVeoPromptParams {
  sceneDescription: string;
  blockStartSec: number;
  blockEndSec: number;
  lockedManifest: LockedRef[];
  attachedReferenceNames: string[];
  dimension: VideoDimension;
}

/**
 * Deterministically composes the final Veo prompt: the LLM-authored
 * scene-specific description plus the fixed CEO-mandated rule blocks.
 * The rule blocks are never left to the LLM to reproduce verbatim, so they
 * cannot drift or be paraphrased away.
 */
export function buildVeoPrompt(params: BuildVeoPromptParams): string {
  const attachedRefs = params.lockedManifest.filter((r) =>
    params.attachedReferenceNames.includes(r.name)
  );

  const sections = [
    `SCENE (block ${params.blockStartSec}s-${params.blockEndSec}s, dimension ${params.dimension}):\n${params.sceneDescription}`,
    buildReferenceMappingRule(attachedRefs, params.lockedManifest),
    attachedRefs.length > 0 ? getNoStaticOpeningRule() : "",
    getNoSpokenWordsRule(),
    getIdentityDiversityRule(),
    buildSingleProductInstanceRule(attachedRefs),
    getPhysicalRealismRule(),
  ];

  return sections.filter(Boolean).join("\n\n");
}
