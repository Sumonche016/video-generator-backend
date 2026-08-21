// The CEO's reference examples (character bible + product bible images) are
// each ONE composite image per subject: a clean contact-sheet-style grid of
// several poses/angles of the SAME subject, arranged together, saved as one
// file (e.g. "MarcusThorne.png"). This is intentional — do not split into
// separate single-pose images.

const COMPOSITE_SHEET_RULE =
  "Arrange all poses together into ONE single composite reference image (a clean contact-sheet / editorial photo grid), not separate images. Every pose must show the exact same identity — same face, same body, same outfit — consistent across all poses in the sheet. Plain neutral studio background behind each pose. Absolutely NO text, labels, numbers, borders, watermarks, or captions anywhere in the image.";

export function buildCharacterBiblePrompt(name: string, description: string, refinementPrompt?: string): string {
  const base = `Create a character reference sheet for one person named "${name}". ${description}
Include a mix of close-up headshots (front view, three-quarter view, side profile) and full-body
shots (standing front view, standing back view, a natural candid pose) of this same person,
photorealistic, professional editorial photography style. ${COMPOSITE_SHEET_RULE}`;
  return refinementPrompt ? `${base}\n\nAdditional direction: ${refinementPrompt}` : base;
}

export function buildProductBiblePrompt(understandingSummary: string, refinementPrompt?: string): string {
  const base = `Create a single image-only professional product bible / product reference sheet for the exact
product shown in the supplied reference image.

The supplied reference image is the absolute visual source of truth. Preserve the product's exact
physical design and do not redesign, reinterpret, modernize, simplify, or add components.

PRODUCT IDENTITY AND CONTEXT: ${understandingSummary}

PRESERVE EXACTLY: the product's exact shape, proportions, colors, materials, finishes, component
count, component placement, and any distinctive structural details visible in the reference image.

IMPORTANT:
Do not add, remove, or alter any component, decoration, or material from what is shown in the
reference image. Do not change counts of repeated parts (e.g. blades, legs, buttons, panels) from
what is shown. Do not change proportions between components.

Create a clean studio product-reference composition showing multiple views/states of the SAME
physical product:

1. large front/bottom or front hero view in its primary resting/off state
2. front view in its primary active/on state (if the product has an on/off or open/closed state)
3. an operating/in-use view showing its primary function active
4. three-quarter perspective view
5. side/profile view showing true proportions between components
6. a mechanical/structural view showing how moving parts connect or deploy, if applicable
7. close-up detail of its most distinctive feature or moving part
8. close-up detail of its primary material/finish and any accent details
9. full assembled product view from a slightly elevated angle
10. full assembled product view from below or another distinct angle

Every panel must depict the SAME exact product with identical geometry, materials, dimensions,
component counts, and component placement.

For any operating/active views, moving parts must deploy or operate naturally and the mechanism
must remain physically plausible. Never make components appear, disappear, morph, stretch, or
change shape between panels.

Use realistic product photography with premium commercial studio lighting, soft neutral
light-gray/white background, subtle natural shadows, realistic reflections and material response,
accurate white balance, high material fidelity, sharp edges, and photorealistic rendering.

The product must remain the only physical object in the image. No people. No hands. No room scene.
No furniture. No props. No packaging.

CRITICAL PRODUCT CONSISTENCY:
Treat the supplied reference as a locked CAD-like visual reference. Maintain exact silhouette,
proportions, geometry, materials, component configuration, and component relationships across
every view.

NO:
- product duplication beyond the individual reference views
- ghost copies
- inconsistent geometry
- component count changes
- morphing
- warped shapes
- distorted proportions
- altered component proportions
- missing components
- extra components
- floating components
- impossible mechanical connections

IMAGE OUTPUT:
Create a clean professional visual reference board only.
NO text. NO labels. NO annotations. NO measurements. NO arrows. NO specifications. NO logos.
NO watermark. NO product name. NO typography of any kind.`;
  return refinementPrompt ? `${base}\n\nAdditional direction: ${refinementPrompt}` : base;
}
