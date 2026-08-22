// The system prompt itself now lives in config/promptRegistry.ts
// (CHARACTER_EXTRACTION_SYSTEM_PROMPT), editable from the web app.
export function buildCharacterExtractionUserMessage(scriptText: string, productSummary: string): string {
  return `The product being advertised in this script (do NOT list this as a character, under any name or alias): ${productSummary}

Voiceover script:\n\n${scriptText}`;
}

export interface ExtractedCharacter {
  name: string;
  description: string;
}

export function parseCharacterExtractionResponse(text: string): ExtractedCharacter[] {
  const parsed = JSON.parse(text) as { characters?: ExtractedCharacter[] };
  if (!Array.isArray(parsed.characters)) return [];
  return parsed.characters.filter((c) => typeof c?.name === "string" && c.name.trim().length > 0);
}
