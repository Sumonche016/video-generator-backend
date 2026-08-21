import type { LockedRef } from "../models/index.js";
import { assignCharacterTags } from "./characterTags.js";

// Told explicitly that the output goes straight to Google Veo 3, so it
// writes a concise, natural, Veo-ready scene description itself (folding in
// the required constraints as part of the scene, not as a separate
// checklist) instead of a generic description that our code then bolts a
// large fixed rulebook onto. Real testing showed very long, checklist-heavy
// prompts are more likely to be blocked by Veo's own safety filter — a
// shorter, naturally-written prompt is both more reliable and cheaper.
export const SCENE_PLANNING_SYSTEM_PROMPT = `You are writing the scene descriptions that will each be sent directly to Google's Veo 3 video
generation model, one per block, to produce a series of consecutive 8-second (or configured length)
clips of a video ad, each synced to a specific slice of the voiceover narration. Veo 3 works best
with a concise (2-4 sentence), natural, cinematic prompt per clip — not a long checklist. Long,
rule-heavy prompts have been observed to get rejected by Veo's own safety filter more often, so keep
each one tight.

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
multiple real human reference photos in one Veo call reliably gets blocked by Veo's safety filter
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
The "blocks" array must have exactly one entry per input block, in the same order they were given.`;

export function buildScenePlanningUserMessage(params: {
  blocks: { blockTranscriptText: string; blockStartSec: number; blockEndSec: number }[];
  fullScriptText: string;
  lockedManifest: LockedRef[];
}): string {
  const tags = assignCharacterTags(params.lockedManifest);
  const manifestList = params.lockedManifest
    .map((r) => (r.kind === "character" ? `${r.name} = ${tags.get(r.name)}` : `${r.name} (product, no tag needed)`))
    .join(", ");

  const blocksList = params.blocks
    .map(
      (b, i) =>
        `Block ${i} (${b.blockStartSec}s-${b.blockEndSec}s): "${b.blockTranscriptText}"`
    )
    .join("\n");

  return `Full script (for context):\n${params.fullScriptText}

Locked reference images available (use the exact tag shown for any character that appears in
a scene): ${manifestList}

Plan the following ${params.blocks.length} consecutive blocks, in order:
${blocksList}`;
}

export interface ScenePlanningResult {
  sceneDescription: string;
  suggestedReferenceNames: string[];
}

export function parseScenePlanningBatchResponse(text: string, expectedCount: number): ScenePlanningResult[] {
  const parsed = JSON.parse(text) as { blocks?: unknown };
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];

  const results: ScenePlanningResult[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const entry = blocks[i] as Partial<ScenePlanningResult> | undefined;
    results.push({
      sceneDescription: typeof entry?.sceneDescription === "string" ? entry.sceneDescription : "",
      suggestedReferenceNames: Array.isArray(entry?.suggestedReferenceNames)
        ? entry.suggestedReferenceNames.filter((n): n is string => typeof n === "string")
        : [],
    });
  }
  return results;
}
