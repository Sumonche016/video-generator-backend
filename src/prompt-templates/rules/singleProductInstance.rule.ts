import type { LockedRef } from "../../models/index.js";

export function buildSingleProductInstanceRule(refs: LockedRef[]): string {
  const productNames = refs.filter((r) => r.kind === "product").map((r) => r.name);
  const nameList = productNames.length > 0 ? productNames.join(", ") : "the specified physical product";
  return `PRODUCT INSTANCE COUNT — CRITICAL:
There is exactly one instance of each specified physical product (${nameList}) unless the prompt explicitly requests multiple units. Never create unintended duplicates or ghost copies.`;
}
