export const PRODUCT_UNDERSTANDING_SYSTEM_PROMPT = `You are a product analyst helping plan a video ad. Given product image(s) and optional
extra info text, describe the product in depth: what it is, its category, key visible features,
materials/colors, and any details relevant to filming it consistently across multiple video
scenes (distinctive shape, logo placement, size cues). Respond in 3-6 concise sentences of plain
text only — no markdown, no headers.`;

export function buildProductUnderstandingUserMessage(infoText: string): string {
  return infoText.trim().length > 0
    ? `This is the product. Understand it in depth. Additional info provided by the user: ${infoText.trim()}`
    : "This is the product. Understand it in depth.";
}
