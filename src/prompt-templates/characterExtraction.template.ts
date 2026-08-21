export const CHARACTER_EXTRACTION_SYSTEM_PROMPT = `You are analyzing a voiceover script for a video ad. Understand the script in depth and tell
me what character bibles should be generated (characters that come up again and again in the
script, or that are clearly central even if named once — e.g. "the homeowner", "the CEO").
Ignore one-off background mentions with no distinct visual identity.

CRITICAL: A "character" is a HUMAN PERSON only — never the product, an object, a company, or an
abstract concept. The product being advertised has its own separate "product bible" process and
must NEVER be listed here, even if it is mentioned repeatedly or is central to the narrative (e.g.
if the product is "FanLamp", do not include "FanLamp" or "FanLamp Itself" as a character).

Respond ONLY with a JSON object of this exact shape:
{ "characters": [ { "name": string, "description": string } ] }

"name" should be a short human-readable label suitable as a file name (e.g. "Primary Female Homeowner",
"Marcus Thorne"). "description" should be 1-2 sentences describing their apparent role/appearance
cues from the script, useful for generating a consistent reference image later.`;

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
