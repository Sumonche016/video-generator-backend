import type { LockedRef } from "../../models/index.js";

export function buildReferenceMappingRule(refs: LockedRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (r) => `- Reference image "${r.name}.png" maps to the ${r.kind} named "${r.name}" in this scene.`
  );
  return `REFERENCE IMAGE MAPPING — CRITICAL:\n${lines.join("\n")}`;
}
