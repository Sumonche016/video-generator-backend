import { getPrompt } from "../../config/promptRegistry.js";

// The rule text itself now lives in config/promptRegistry.ts
// (NO_SPOKEN_WORDS_RULE), editable from the web app.
export function getNoSpokenWordsRule(): string {
  return getPrompt("NO_SPOKEN_WORDS_RULE");
}
