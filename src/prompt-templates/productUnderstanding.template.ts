// The system prompt itself now lives in config/promptRegistry.ts
// (PRODUCT_UNDERSTANDING_SYSTEM_PROMPT), editable from the web app.
export function buildProductUnderstandingUserMessage(infoText: string): string {
  return infoText.trim().length > 0
    ? `This is the product. Understand it in depth. Additional info provided by the user: ${infoText.trim()}`
    : "This is the product. Understand it in depth.";
}
