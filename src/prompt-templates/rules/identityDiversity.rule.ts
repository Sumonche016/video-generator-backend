import { getPrompt } from "../../config/promptRegistry.js";

// The rule text itself now lives in config/promptRegistry.ts
// (IDENTITY_DIVERSITY_RULE), editable from the web app.
export function getIdentityDiversityRule(): string {
  return getPrompt("IDENTITY_DIVERSITY_RULE");
}
