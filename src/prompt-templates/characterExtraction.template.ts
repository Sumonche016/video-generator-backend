export const CHARACTER_EXTRACTION_SYSTEM_PROMPT = `You are analyzing a voiceover script for a video ad. Understand the script in depth and tell
me what character bibles should be generated (characters that come up again and again in the
script, or that are clearly central even if named once — e.g. "the homeowner", "the CEO").
Ignore one-off background mentions with no distinct visual identity.

Respond ONLY with a JSON object of this exact shape:
{ "characters": [ { "name": string, "description": string } ] }

"name" should be a short human-readable label suitable as a file name (e.g. "Primary Female Homeowner",
"Marcus Thorne"). "description" should be 1-2 sentences describing their apparent role/appearance
cues from the script, useful for generating a consistent reference image later.`;

export function buildCharacterExtractionUserMessage(scriptText: string): string {
  return `Voiceover script:\n\n${scriptText}`;
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
