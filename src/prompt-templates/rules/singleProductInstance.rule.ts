import type { LockedRef } from "../../models/index.js";
import { renderPrompt } from "../../config/promptRegistry.js";

// The wrapper text itself now lives in config/promptRegistry.ts
// (SINGLE_PRODUCT_INSTANCE_RULE, with a {{PRODUCT_NAMES}} placeholder),
// editable from the web app. Only the per-call product-name list stays here.
export function buildSingleProductInstanceRule(refs: LockedRef[]): string {
  const productNames = refs.filter((r) => r.kind === "product").map((r) => r.name);
  const nameList = productNames.length > 0 ? productNames.join(", ") : "the specified physical product";
  return renderPrompt("SINGLE_PRODUCT_INSTANCE_RULE", { "{{PRODUCT_NAMES}}": nameList });
}
