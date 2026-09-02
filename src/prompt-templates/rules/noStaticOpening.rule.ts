import { getPrompt } from "../../config/promptRegistry.js";

// The rule text itself lives in config/promptRegistry.ts
// (NO_STATIC_OPENING_RULE), editable from the web app.
export function getNoStaticOpeningRule(): string {
  return getPrompt("NO_STATIC_OPENING_RULE");
}
