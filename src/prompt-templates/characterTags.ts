import type { LockedRef } from "../models/index.js";

// Verified via real Veo testing: sending 2+ photorealistic human reference
// images together gets blocked by Veo's safety filter almost every time,
// UNLESS the prompt explicitly binds each image to a tag like <character_1>,
// <character_2> and the scene description uses those exact tags instead of
// names. Tags are assigned once per project, based on the locked manifest's
// fixed order, so <character_1> always refers to the same person in every
// block's prompt (stable across the whole project, not per-block).
export function assignCharacterTags(lockedManifest: LockedRef[]): Map<string, string> {
  const tags = new Map<string, string>();
  let n = 0;
  for (const ref of lockedManifest) {
    if (ref.kind === "character") {
      n += 1;
      tags.set(ref.name, `<character_${n}>`);
    }
  }
  return tags;
}
