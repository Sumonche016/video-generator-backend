import { renderPrompt } from "../config/promptRegistry.js";

// The base templates themselves (CHARACTER_BIBLE_PROMPT / PRODUCT_BIBLE_PROMPT,
// with {{NAME}}/{{DESCRIPTION}}/{{UNDERSTANDING_SUMMARY}} placeholders) now
// live in config/promptRegistry.ts, editable from the web app. Only the
// per-generation variable substitution and the user-supplied refinement
// suffix (not part of the editable template) stay here.

export function buildCharacterBiblePrompt(name: string, description: string, refinementPrompt?: string): string {
  const base = renderPrompt("CHARACTER_BIBLE_PROMPT", { "{{NAME}}": name, "{{DESCRIPTION}}": description });
  return refinementPrompt ? `${base}\n\nAdditional direction: ${refinementPrompt}` : base;
}

export function buildProductBiblePrompt(understandingSummary: string, refinementPrompt?: string): string {
  const base = renderPrompt("PRODUCT_BIBLE_PROMPT", { "{{UNDERSTANDING_SUMMARY}}": understandingSummary });
  return refinementPrompt ? `${base}\n\nAdditional direction: ${refinementPrompt}` : base;
}
