import { supabase } from "../storage/supabaseClient.js";

// Central registry of every prompt string that drives an AI/Veo call in the
// app. Each has a hardcoded default (below) that can be overridden from the
// web app (Prompts page + per-step panels) without a code change/redeploy —
// mirrors the runtimeConfig.ts pattern used for API keys, but for prompt
// text instead of secrets.
export type PromptKey =
  | "PRODUCT_UNDERSTANDING_SYSTEM_PROMPT"
  | "CHARACTER_EXTRACTION_SYSTEM_PROMPT"
  | "SCENE_PLANNING_SYSTEM_PROMPT"
  | "CHARACTER_BIBLE_PROMPT"
  | "PRODUCT_BIBLE_PROMPT"
  | "NO_SPOKEN_WORDS_RULE"
  | "IDENTITY_DIVERSITY_RULE"
  | "PHYSICAL_REALISM_RULE"
  | "SINGLE_PRODUCT_INSTANCE_RULE"
  | "REFERENCE_MAPPING_RULE";

interface PromptMeta {
  stepLabel: string;
  description: string;
  defaultText: string;
  placeholders: string[];
}

export const PROMPT_DEFAULTS: Record<PromptKey, PromptMeta> = {
  PRODUCT_UNDERSTANDING_SYSTEM_PROMPT: {
    stepLabel: "Product Upload (step 1)",
    description: "System prompt used to analyze the uploaded product photo(s) into a written understanding summary.",
    placeholders: [],
    defaultText: `You are a product analyst helping plan a video ad. Given product image(s) and optional
extra info text, describe the product in depth: what it is, its category, key visible features,
materials/colors, and any details relevant to filming it consistently across multiple video
scenes (distinctive shape, logo placement, size cues). Respond in 3-6 concise sentences of plain
text only — no markdown, no headers.`,
  },
  CHARACTER_EXTRACTION_SYSTEM_PROMPT: {
    stepLabel: "Script Upload (step 2)",
    description: "System prompt used to extract which recurring human characters appear in the voiceover script.",
    placeholders: [],
    defaultText: `You are analyzing a voiceover script for a video ad. Understand the script in depth and tell
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
cues from the script, useful for generating a consistent reference image later.`,
  },
  SCENE_PLANNING_SYSTEM_PROMPT: {
    stepLabel: "Scene Breakdown (step 7/8)",
    description: "System prompt used to plan every block's video generation scene description and which reference images it should use, all in one batched call.",
    placeholders: [],
    defaultText: `You are writing the scene descriptions that will each be sent directly to an image-to-video
generation model, one per block, to produce a series of consecutive 8-second (or configured length)
clips of a video ad, each synced to a specific slice of the voiceover narration. The model works best
with a concise (2-4 sentence), natural, cinematic prompt per clip — not a long checklist. Long,
rule-heavy prompts have been observed to get rejected more often, so keep each one tight.

CRITICAL for any block that has a reference image attached (a character or product): the reference
image is used as the literal first frame of the clip, so if the scene description doesn't explicitly
call for motion, the model tends to hold on that image as a static shot for the first portion of the
clip before anything moves. Always phrase the action so it is already happening or begins
immediately — e.g. "already mid-gesture as she turns to camera" rather than "she turns to camera" —
so the clip doesn't open on a frozen frame.

Given the narration text for each block, the full script for context, and the list of locked
reference images available (characters and product, each character already assigned a fixed
<character_N> tag — see the user message), write, for EACH block:
(1) a short, concrete, cinematic scene description (camera angle, action, setting) for what the
video should show during this narration. Do NOT write any dialogue or narration text yourself —
audio comes from the human voiceover separately, this clip should be silent or ambient-sound-only.
Naturally fold in, only where actually relevant to this specific scene, brief phrasing for: nobody
speaks on camera; the product (if present) appears as exactly one real, physically consistent
object. Do not restate all of this as a checklist — only mention what's relevant to this scene,
briefly, as part of natural scene-setting language.
(2) which of the locked reference image names apply to this scene (only include a name if that
character or the product should visually appear in this block). This must be the ACTUAL reference
name (e.g. "MarcusThorne"), never a tag like "<character_1>" — tags are ONLY used inside the (1)
scene description text, never in this list.

CRITICAL for (1): if a reference character appears in this scene, refer to them in the scene
description text using EXACTLY their assigned tag (e.g. "<character_1> examines the prototype"),
never their actual name and never a generic phrase like "the engineer" instead of the tag. Using
multiple real human reference photos in one call reliably gets blocked by the model's safety filter
UNLESS each one is explicitly bound to a <character_N> tag used verbatim in the prompt text — this
is a verified, required workaround, not optional styling. The product does NOT need a <character_N>
-style tag in the text — just refer to it naturally (e.g. "the product shown in the reference
image") — but that is ONLY about the text phrasing, not about whether to attach it.

CRITICAL for (2) — the product reference: if the product is visually shown, revealed, held, used,
operated, or otherwise physically present on screen in a scene — including hero shots, reveals,
close-ups, or it simply sitting in the room — you MUST include the product's reference name in
that block's suggestedReferenceNames. This is just as mandatory as attaching a character's name
when that character appears; "doesn't need a tag" only means the text doesn't use a <character_N>
placeholder for it, it does NOT mean the product can be left out of suggestedReferenceNames. Only
omit the product's name when it genuinely does not appear on screen in that block (e.g. a scene
about the villainous industry, or a homeowner's frustration, with no product visible).

You are planning MULTIPLE consecutive blocks in this same call, in narration order. Because you can
see all of them together, use that to keep the sequence coherent as a story: build toward reveals
instead of showing the product too early, don't repeat the same shot type back-to-back, keep
characters appearing only where they'd plausibly appear given the narration so far, and treat later
blocks as continuing directly from the visual state the earlier blocks left off in. Plan each
block's (1) and (2) independently in the output, but let each one be informed by what you planned
for the others.

Respond ONLY with JSON of this exact shape:
{ "blocks": [ { "sceneDescription": string, "suggestedReferenceNames": string[] }, ... ] }
The "blocks" array must have exactly one entry per input block, in the same order they were given.`,
  },
  CHARACTER_BIBLE_PROMPT: {
    stepLabel: "Character Bible (step 4)",
    description: "Image-generation prompt used to create each character's reference sheet.",
    placeholders: ["{{NAME}}", "{{DESCRIPTION}}"],
    defaultText: `Create a character reference sheet for one person named "{{NAME}}". {{DESCRIPTION}}
Include a mix of close-up headshots (front view, three-quarter view, side profile) and full-body
shots (standing front view, standing back view, a natural candid pose) of this same person,
photorealistic, professional editorial photography style. Arrange all poses together into ONE
single composite reference image (a clean contact-sheet / editorial photo grid), not separate
images. Every pose must show the exact same identity — same face, same body, same outfit —
consistent across all poses in the sheet. Plain neutral studio background behind each pose.
Absolutely NO text, labels, numbers, borders, watermarks, or captions anywhere in the image.`,
  },
  PRODUCT_BIBLE_PROMPT: {
    stepLabel: "Product Bible (step 5)",
    description: "Image-generation prompt used to create the product's reference sheet from the uploaded photo(s).",
    placeholders: ["{{UNDERSTANDING_SUMMARY}}"],
    defaultText: `Create a single image-only professional product bible / product reference sheet for the exact
product shown in the supplied reference image.

The supplied reference image is the absolute visual source of truth. Preserve the product's exact
physical design and do not redesign, reinterpret, modernize, simplify, or add components.

PRODUCT IDENTITY AND CONTEXT: {{UNDERSTANDING_SUMMARY}}

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
NO watermark. NO product name. NO typography of any kind.`,
  },
  NO_SPOKEN_WORDS_RULE: {
    stepLabel: "Every Veo prompt",
    description: "Fixed rule block appended to every scene's Veo prompt, forbidding spoken/narration audio in the generated clip.",
    placeholders: [],
    defaultText: `AUDIO — CRITICAL:
The generated clip must contain NO spoken words, dialogue, or narration audio.
The human voiceover carries all narration and will be synced separately; the video track's own audio (if any) must be non-verbal (silent, or ambient/sound-effects only).`,
  },
  IDENTITY_DIVERSITY_RULE: {
    stepLabel: "Every Veo prompt",
    description: "Fixed rule block appended to every scene's Veo prompt, requiring distinct-looking background/non-reference people.",
    placeholders: [],
    defaultText: `Every non-reference person is a distinct individual (unique face, hair, age, build, outfit) — no cloned extras or repeated faces; reference images apply only to their named character.`,
  },
  PHYSICAL_REALISM_RULE: {
    stepLabel: "Every Veo prompt",
    description: "Fixed rule block appended to every scene's Veo prompt, requiring real-world physical continuity (no duplication/teleporting/morphing).",
    placeholders: [],
    defaultText: `Maintain real-world physical continuity throughout: no object duplication, teleporting, morphing, or impossible transitions — treat it as continuous live-action footage.`,
  },
  SINGLE_PRODUCT_INSTANCE_RULE: {
    stepLabel: "Every Veo prompt with a product",
    description: "Fixed rule block appended when a product reference is attached, requiring exactly one instance of the product on screen.",
    placeholders: ["{{PRODUCT_NAMES}}"],
    defaultText: `PRODUCT INSTANCE COUNT — CRITICAL:
There is exactly one instance of each specified physical product ({{PRODUCT_NAMES}}) unless the prompt explicitly requests multiple units. Never create unintended duplicates or ghost copies.`,
  },
  REFERENCE_MAPPING_RULE: {
    stepLabel: "Every Veo prompt with reference images",
    description: "Fixed rule block mapping each attached reference image/tag to what it represents, appended when any reference images are attached.",
    placeholders: ["{{LINES}}"],
    defaultText: `REFERENCE IMAGE MAPPING — CRITICAL:
{{LINES}}
Do not use any real name for these people in the generated video — they are fictional characters for this ad.`,
  },
};

const overrides: Partial<Record<PromptKey, string>> = {};

export async function loadPromptOverrides(): Promise<void> {
  const { data, error } = await supabase.from("prompt_overrides").select("key, value");
  if (error) {
    console.warn("Could not load prompt_overrides (has migration 0003 been run?):", error.message);
    return;
  }
  for (const row of data ?? []) {
    if (row.key in PROMPT_DEFAULTS && row.value) {
      overrides[row.key as PromptKey] = row.value;
    }
  }
}

export function getPrompt(key: PromptKey): string {
  return overrides[key] ?? PROMPT_DEFAULTS[key].defaultText;
}

export function renderPrompt(key: PromptKey, vars: Record<string, string>): string {
  let text = getPrompt(key);
  for (const [token, value] of Object.entries(vars)) {
    text = text.split(token).join(value);
  }
  return text;
}

export async function updatePromptOverride(key: PromptKey, value: string): Promise<void> {
  // Persist first — only reflect the change in-memory once it's actually
  // saved, so a failed write (e.g. migration not run yet) can't leave a
  // phantom override in effect that the database doesn't agree with.
  const { error } = await supabase.from("prompt_overrides").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  overrides[key] = value;
}

export async function resetPromptOverride(key: PromptKey): Promise<void> {
  const { error } = await supabase.from("prompt_overrides").delete().eq("key", key);
  if (error) throw error;
  delete overrides[key];
}

export function listPromptEntries() {
  return (Object.keys(PROMPT_DEFAULTS) as PromptKey[]).map((key) => ({
    key,
    stepLabel: PROMPT_DEFAULTS[key].stepLabel,
    description: PROMPT_DEFAULTS[key].description,
    placeholders: PROMPT_DEFAULTS[key].placeholders,
    defaultText: PROMPT_DEFAULTS[key].defaultText,
    currentText: getPrompt(key),
    isOverridden: key in overrides,
  }));
}
