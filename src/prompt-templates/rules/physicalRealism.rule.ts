import { getPrompt } from "../../config/promptRegistry.js";

// The rule text itself now lives in config/promptRegistry.ts
// (PHYSICAL_REALISM_RULE), editable from the web app.
export function getPhysicalRealismRule(): string {
  return getPrompt("PHYSICAL_REALISM_RULE");
}
