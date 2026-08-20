import type { LockedRef, VideoDimension } from "../models/index.js";
import { NO_SPOKEN_WORDS_RULE } from "./rules/noSpokenWords.rule.js";
import { buildReferenceMappingRule } from "./rules/referenceMapping.rule.js";
import { IDENTITY_DIVERSITY_RULE } from "./rules/identityDiversity.rule.js";
import { buildSingleProductInstanceRule } from "./rules/singleProductInstance.rule.js";
import { PHYSICAL_REALISM_RULE } from "./rules/physicalRealism.rule.js";

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
    buildReferenceMappingRule(attachedRefs),
    NO_SPOKEN_WORDS_RULE,
    IDENTITY_DIVERSITY_RULE,
    buildSingleProductInstanceRule(attachedRefs),
    PHYSICAL_REALISM_RULE,
  ];

  return sections.filter(Boolean).join("\n\n");
}
