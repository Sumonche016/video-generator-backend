import { getLLMProvider } from "../config/providers.config.js";
import { getPrompt } from "../config/promptRegistry.js";
import { supabase } from "../storage/supabaseClient.js";
import { downloadAsset, uploadAsset, assetPaths } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage, assertStageAtLeast } from "./project.service.js";
import { parseElevenLabsTranscript } from "./voiceover.service.js";
import { buildVeoPrompt } from "../prompt-templates/veoPromptTemplate.js";
import {
  buildScenePlanningUserMessage,
  parseScenePlanningBatchResponse,
} from "../prompt-templates/scenePlanning.template.js";
import type { Block, LockedRef, WordTiming } from "../models/index.js";

interface BlockRow {
  id: string;
  project_id: string;
  index: number;
  start_sec: number;
  end_sec: number;
  transcript_text: string;
  word_timings: WordTiming[];
  veo_prompt: string;
  attached_reference_names: string[];
  approval_status: Block["approvalStatus"];
  clip_attempts: Block["clipAttempts"];
  approved_clip_path: string | null;
  audio_leveling: Block["audioLeveling"];
  gap_filler_prompt: string;
  gap_filler_attempts: Block["clipAttempts"];
  approved_gap_filler_path: string | null;
}

function mapBlockRow(row: BlockRow): Block {
  return {
    index: row.index,
    startSec: row.start_sec,
    endSec: row.end_sec,
    transcriptText: row.transcript_text,
    wordTimings: row.word_timings,
    veoPrompt: row.veo_prompt,
    attachedReferenceNames: row.attached_reference_names,
    approvalStatus: row.approval_status,
    clipAttempts: row.clip_attempts,
    approvedClipPath: row.approved_clip_path,
    audioLeveling: row.audio_leveling,
    gapFillerPrompt: row.gap_filler_prompt,
    gapFillerAttempts: row.gap_filler_attempts,
    approvedGapFillerPath: row.approved_gap_filler_path,
  };
}

function splitIntoBlocks(words: WordTiming[], blockDurationSeconds: number): { startSec: number; endSec: number; words: WordTiming[] }[] {
  if (words.length === 0) return [];
  const totalDuration = words[words.length - 1].end;
  const blocks: { startSec: number; endSec: number; words: WordTiming[] }[] = [];

  for (let start = 0; start < totalDuration; start += blockDurationSeconds) {
    const end = start + blockDurationSeconds;
    const blockWords = words.filter((w) => w.start >= start && w.start < end);
    blocks.push({ startSec: start, endSec: end, words: blockWords });
  }
  return blocks;
}

// Splits the voiceover into timed blocks — fast, no AI calls. For a long
// voiceover (e.g. 40 blocks) this must NOT also generate all 40 Veo prompts
// synchronously in one request; prompt generation is a separate, batched
// step (see generateNextPromptBatch) so the UI can generate 5 at a time,
// matching the same "next batch" pattern used for Veo clip generation.
export async function splitIntoBlocksAndSave(projectId: string): Promise<Block[]> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  assertStageAtLeast(project, "VOICEOVER_UPLOADED");
  if (!project.voiceover) throw new Error("No voiceover uploaded yet");
  if (!project.lockedManifest) throw new Error("Project is not locked yet");

  const { buffer } = await downloadAsset(project.voiceover.transcriptPath);
  const transcriptJson = JSON.parse(buffer.toString("utf-8"));
  const words = parseElevenLabsTranscript(transcriptJson);
  const rawBlocks = splitIntoBlocks(words, project.settings.blockDurationSeconds);

  const rows = rawBlocks.map((raw, index) => ({
    project_id: projectId,
    index,
    start_sec: raw.startSec,
    end_sec: raw.endSec,
    transcript_text: raw.words.map((w) => w.word).join(" "),
    word_timings: raw.words,
    veo_prompt: "", // empty = not yet AI-planned; generateNextPromptBatch fills this in, 5 at a time
    attached_reference_names: [],
    approval_status: "pending" as const,
  }));

  // Re-splitting must not leave stale blocks from a previous run behind.
  await supabase.from("blocks").delete().eq("project_id", projectId);
  const { data, error } = await supabase.from("blocks").insert(rows).select().order("index");
  if (error) throw error;

  advanceStage(project, "BLOCKS_PLANNED");
  await saveProject(project);

  return (data as BlockRow[]).map(mapBlockRow);
}

// Plans every not-yet-planned block in a SINGLE LLM call, all together, so
// the model can see the whole pending sequence at once and keep it coherent
// as a story (build toward reveals, avoid repeating shot types, avoid
// showing the product before its reveal beat, etc.) instead of each block
// being planned blind to what the others decided.
export async function generateNextPromptBatch(projectId: string): Promise<Block[]> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.lockedManifest) throw new Error("Project is not locked yet");

  const { data: pendingRows, error } = await supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .eq("veo_prompt", "")
    .order("index");
  if (error) throw error;

  const rows = pendingRows as BlockRow[];
  if (rows.length === 0) return [];

  const llm = getLLMProvider();
  const lockedManifest = project.lockedManifest;

  const planResult = await llm.chat({
    systemPrompt: getPrompt("SCENE_PLANNING_SYSTEM_PROMPT"),
    messages: [
      {
        role: "user",
        content: buildScenePlanningUserMessage({
          blocks: rows.map((row) => ({
            blockTranscriptText: row.transcript_text,
            blockStartSec: row.start_sec,
            blockEndSec: row.end_sec,
          })),
          fullScriptText: project.script.text,
          lockedManifest,
        }),
      },
    ],
    responseFormat: "json",
  });
  const plans = parseScenePlanningBatchResponse(planResult.text, rows.length);

  const updated: Block[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { sceneDescription, suggestedReferenceNames } = plans[i];

    const veoPrompt = buildVeoPrompt({
      sceneDescription,
      blockStartSec: row.start_sec,
      blockEndSec: row.end_sec,
      lockedManifest,
      attachedReferenceNames: suggestedReferenceNames,
      dimension: project.dimension,
    });

    const { data, error: updateError } = await supabase
      .from("blocks")
      .update({ veo_prompt: veoPrompt, attached_reference_names: suggestedReferenceNames })
      .eq("project_id", projectId)
      .eq("index", row.index)
      .select()
      .single();
    if (updateError) throw updateError;
    updated.push(mapBlockRow(data as BlockRow));
  }

  return updated;
}

export async function listBlocks(projectId: string): Promise<Block[]> {
  const { data, error } = await supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .order("index");
  if (error) throw error;
  return (data as BlockRow[]).map(mapBlockRow);
}

export async function getBlock(projectId: string, index: number): Promise<Block> {
  const { data, error } = await supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .eq("index", index)
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function updateBlock(
  projectId: string,
  index: number,
  patch: { veoPrompt?: string; attachedReferenceNames?: string[]; gapFillerPrompt?: string }
): Promise<Block> {
  const updates: Record<string, unknown> = {};
  if (patch.veoPrompt !== undefined) updates.veo_prompt = patch.veoPrompt;
  if (patch.attachedReferenceNames !== undefined) updates.attached_reference_names = patch.attachedReferenceNames;
  if (patch.gapFillerPrompt !== undefined) updates.gap_filler_prompt = patch.gapFillerPrompt;

  const { data, error } = await supabase
    .from("blocks")
    .update(updates)
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

// Lets a scene use a brand-new reference photo the AI didn't already attach
// (e.g. a background extra, an extra product angle) without touching which
// images the AI itself chose for other scenes. The uploaded image is added
// as a new named entry to the project's locked manifest (so Veo can resolve
// it like any other reference) and immediately attached to this one block.
export async function addBlockReferenceImage(
  projectId: string,
  index: number,
  file: { buffer: Buffer; mimetype: string; originalname: string }
): Promise<Block> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.lockedManifest) throw new Error("Project is not locked yet");

  const name = `Custom${Date.now()}`;
  const ext = file.originalname.includes(".") ? file.originalname.split(".").pop() : "png";
  const objectKey = assetPaths.customReference(projectId, name, `image.${ext}`);
  await uploadAsset(objectKey, file.buffer, file.mimetype);

  const newRef: LockedRef = { name, kind: "character", imagePath: objectKey };
  project.lockedManifest = [...project.lockedManifest, newRef];
  await saveProject(project);

  const { data: existingRow, error: fetchError } = await supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .eq("index", index)
    .single();
  if (fetchError) throw fetchError;
  const attachedReferenceNames = [...(existingRow as BlockRow).attached_reference_names, name];

  const { data, error } = await supabase
    .from("blocks")
    .update({ attached_reference_names: attachedReferenceNames })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function approveBlockPrompt(projectId: string, index: number): Promise<Block> {
  const { data, error } = await supabase
    .from("blocks")
    .update({ approval_status: "prompt_approved" })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

// Bulk-approve every block that has a generated prompt but hasn't been
// individually approved yet — clicking "Approve" one at a time doesn't
// scale to a 30+ scene video, so this is the one-click alternative.
export async function approveAllPrompts(projectId: string): Promise<Block[]> {
  const { data, error } = await supabase
    .from("blocks")
    .update({ approval_status: "prompt_approved" })
    .eq("project_id", projectId)
    .eq("approval_status", "pending")
    .neq("veo_prompt", "")
    .select()
    .order("index");
  if (error) throw error;
  return (data as BlockRow[]).map(mapBlockRow);
}
