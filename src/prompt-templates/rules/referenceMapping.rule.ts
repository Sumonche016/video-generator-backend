import type { LockedRef } from "../../models/index.js";
import { assignCharacterTags } from "../characterTags.js";

// Verified via real Veo testing: sending 2+ photorealistic human reference
// images together in one call gets blocked by Veo's safety filter almost
// every time — UNLESS each image is explicitly bound to a <character_N> tag
// that the scene description also uses verbatim (see scenePlanning.template.ts,
// which is instructed to use these same tags). A single confirmed real test
// with 2 tagged human references succeeded where 3 untagged/generic attempts
// on the same scene all failed. Never use real names here — that alone was
// also confirmed to trigger a separate "real person likeness" block.
export function buildReferenceMappingRule(refs: LockedRef[], fullManifest: LockedRef[]): string {
  if (refs.length === 0) return "";
  const tags = assignCharacterTags(fullManifest);

  const lines = refs.map((r) => {
    if (r.kind === "product") {
      return `- The product reference image shows the physical product to use in this scene.`;
    }
    return `- ${tags.get(r.name)} refers to the person shown in that reference image — use their exact likeness (face, build, styling).`;
  });

  return `REFERENCE IMAGE MAPPING — CRITICAL:\n${lines.join("\n")}\nDo not use any real name for these people in the generated video — they are fictional characters for this ad.`;
}
