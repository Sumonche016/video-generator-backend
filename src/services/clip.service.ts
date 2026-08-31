import { getVideoGenProvider } from "../config/providers.config.js";
import { supabase } from "../storage/supabaseClient.js";
import { assetPaths, uploadAsset, downloadAsset } from "../storage/assetStorage.js";
import { measureVolumeDb, applyAudioGain } from "./audio.service.js";
import { probeDurationSeconds } from "./ffprobe.service.js";
import { trimVideoBuffer, concatVideoBuffers } from "./videoEdit.service.js";
import { getProject, advanceStage, saveProject } from "./project.service.js";
import type { Block, ClipAttempt, LockedRef } from "../models/index.js";

interface BlockRow {
  id: string;
  project_id: string;
  index: number;
  start_sec: number;
  end_sec: number;
  transcript_text: string;
  word_timings: Block["wordTimings"];
  veo_prompt: string;
  attached_reference_names: string[];
  approval_status: Block["approvalStatus"];
  clip_attempts: ClipAttempt[];
  approved_clip_path: string | null;
  audio_leveling: Block["audioLeveling"];
  gap_filler_prompt: string;
  gap_filler_attempts: ClipAttempt[];
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

async function getBlockRow(projectId: string, index: number): Promise<BlockRow> {
  const { data, error } = await supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .eq("index", index)
    .single();
  if (error) throw error;
  return data as BlockRow;
}

function resolveReferenceImages(lockedManifest: LockedRef[], names: string[]) {
  return lockedManifest
    .filter((r) => names.includes(r.name))
    .map((r) => ({ name: r.name, path: r.imagePath, role: r.kind }));
}

export async function generateNextBatch(
  projectId: string,
  opts?: { indices?: number[]; count?: number }
): Promise<Block[]> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.lockedManifest) throw new Error("Project is not locked yet");

  let query = supabase
    .from("blocks")
    .select()
    .eq("project_id", projectId)
    .eq("approval_status", "prompt_approved")
    .order("index");
  query = opts?.indices?.length ? query.in("index", opts.indices) : query.limit(opts?.count ?? project.settings.batchSize);
  const { data: pendingRows, error } = await query;
  if (error) throw error;

  const videoGen = getVideoGenProvider();

  // All blocks in this batch are submitted to Veo simultaneously (not one
  // at a time) — each generateClip() call only submits the job and returns
  // a jobId immediately, so there's no reason to wait for one submission
  // before starting the next.
  const updated = await Promise.all(
    (pendingRows as BlockRow[]).map(async (row) => {
      const { jobId } = await videoGen.generateClip({
        prompt: row.veo_prompt,
        referenceImages: resolveReferenceImages(project.lockedManifest as LockedRef[], row.attached_reference_names),
        durationSeconds: row.end_sec - row.start_sec,
        dimension: project.dimension,
      });

      const attempt: ClipAttempt = { path: "", createdAt: new Date().toISOString(), status: "running", jobId };
      const clipAttempts = [...row.clip_attempts, attempt];

      const { data, error: updateError } = await supabase
        .from("blocks")
        .update({ clip_attempts: clipAttempts, approval_status: "clip_generating" })
        .eq("project_id", projectId)
        .eq("index", row.index)
        .select()
        .single();
      if (updateError) throw updateError;
      return mapBlockRow(data as BlockRow);
    })
  );

  if (updated.length > 0) {
    advanceStage(project, "BLOCKS_GENERATING");
    await saveProject(project);
  }

  return updated;
}

export async function pollClipStatus(projectId: string, index: number): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const attempts = row.clip_attempts;
  const latest = attempts[attempts.length - 1];
  if (!latest || latest.status !== "running" || !latest.jobId) {
    return mapBlockRow(row);
  }

  const videoGen = getVideoGenProvider();
  const status = await videoGen.pollStatus(latest.jobId);

  if (status.status === "running" || status.status === "pending") {
    return mapBlockRow(row);
  }

  if (status.status === "failed") {
    latest.status = "failed";
    latest.error = status.error;
    const { data, error } = await supabase
      .from("blocks")
      .update({ clip_attempts: attempts, approval_status: "prompt_approved" })
      .eq("project_id", projectId)
      .eq("index", index)
      .select()
      .single();
    if (error) throw error;
    return mapBlockRow(data as BlockRow);
  }

  // succeeded — download from the provider's temporary URL and persist into our own storage.
  const videoRes = await fetch(status.videoUrl as string, { headers: status.videoHeaders });
  if (!videoRes.ok) throw new Error(`Failed to download generated clip: ${videoRes.status}`);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const objectKey = assetPaths.blockClip(projectId, index, `attempt-${attempts.length}.mp4`);
  await uploadAsset(objectKey, buffer, "video/mp4");

  latest.status = "succeeded";
  latest.path = objectKey;
  try {
    latest.durationSeconds = await probeDurationSeconds(buffer, "mp4");
  } catch {
    // Duration is a nice-to-have signal for the reviewer/assembler; if
    // ffprobe fails for some reason, assembly still falls back to trimming
    // safely against the requested slice length.
  }

  // Per the CEO's spec: auto-check the clip's audio volume against the
  // voiceover's — the tool measures both automatically here; whether to
  // duck it down is left as a manual human decision for now (see
  // applyDucking / the audio-level endpoint), not applied automatically.
  const audioLeveling = { ...row.audio_leveling };
  try {
    const project = await getProject(projectId);
    if (project?.voiceover) {
      const { buffer: voiceoverBuffer } = await downloadAsset(project.voiceover.mp3Path);
      const [clipDb, voiceoverDb] = await Promise.all([
        measureVolumeDb(buffer, "mp4"),
        measureVolumeDb(voiceoverBuffer, "mp3"),
      ]);
      audioLeveling.veoClipVolumeDb = clipDb;
      audioLeveling.voiceoverVolumeDb = voiceoverDb;
    }
  } catch {
    // Volume measurement is a nice-to-have signal for the human reviewer,
    // not a hard requirement — never fail clip generation because of it.
  }

  const { data, error } = await supabase
    .from("blocks")
    .update({ clip_attempts: attempts, approval_status: "clip_review", audio_leveling: audioLeveling })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function applyDucking(projectId: string, index: number, duckingFactor: number): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const latest = row.clip_attempts[row.clip_attempts.length - 1];
  const clipPath = latest?.status === "succeeded" && latest.path ? latest.path : row.approved_clip_path;
  if (!clipPath) {
    throw new Error("No succeeded or approved clip to apply audio ducking to");
  }

  const { buffer } = await downloadAsset(clipPath);
  const ducked = await applyAudioGain(buffer, duckingFactor);
  await uploadAsset(clipPath, ducked, "video/mp4");
  const newClipDb = await measureVolumeDb(ducked, "mp4");

  const audioLeveling = {
    ...row.audio_leveling,
    veoClipVolumeDb: newClipDb,
    duckingApplied: true,
    duckingFactor,
  };

  const { data, error } = await supabase
    .from("blocks")
    .update({ audio_leveling: audioLeveling })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function approveClip(projectId: string, index: number): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const latest = row.clip_attempts[row.clip_attempts.length - 1];
  if (!latest || latest.status !== "succeeded") {
    throw new Error("No succeeded clip attempt to approve for this block");
  }

  const { data, error } = await supabase
    .from("blocks")
    .update({ approval_status: "approved", approved_clip_path: latest.path })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;

  const project = await getProject(projectId);
  if (project) {
    const { data: remaining } = await supabase
      .from("blocks")
      .select("index")
      .eq("project_id", projectId)
      .neq("approval_status", "approved");
    if (!remaining || remaining.length === 0) {
      advanceStage(project, "BLOCKS_APPROVED");
      await saveProject(project);
    }
  }

  return mapBlockRow(data as BlockRow);
}

function currentClipPath(row: BlockRow): string | null {
  const latest = row.clip_attempts[row.clip_attempts.length - 1];
  if (latest?.status === "succeeded" && latest.path) return latest.path;
  return row.approved_clip_path;
}

// User-initiated cut: trims the block's current clip right now and makes the
// trimmed result the new definitive clip immediately (not a value applied
// later at assembly) — the point is the user sees the actual cut clip
// in this stage, not a deferred computation.
export async function trimClip(projectId: string, index: number, trimStartSec: number, trimEndSec: number): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const sourcePath = currentClipPath(row);
  if (!sourcePath) throw new Error("No clip to trim for this block yet");

  const { buffer } = await downloadAsset(sourcePath);
  const duration = await probeDurationSeconds(buffer, "mp4");
  const newDuration = Math.max(0, duration - trimStartSec - trimEndSec);
  const trimmedBuffer = await trimVideoBuffer(buffer, trimStartSec, newDuration);

  const objectKey = assetPaths.blockClip(projectId, index, `cut-${Date.now()}.mp4`);
  await uploadAsset(objectKey, trimmedBuffer, "video/mp4");

  const attempt: ClipAttempt = {
    path: objectKey,
    createdAt: new Date().toISOString(),
    status: "succeeded",
    durationSeconds: await probeDurationSeconds(trimmedBuffer, "mp4").catch(() => newDuration),
  };
  const clipAttempts = [...row.clip_attempts, attempt];

  const { data, error } = await supabase
    .from("blocks")
    .update({ clip_attempts: clipAttempts, approved_clip_path: objectKey })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

// Generates a small filler clip to cover the leftover time when a block's
// main clip comes up short of its voiceover slice (Veo always returns ~8s
// regardless of what's requested, so a manual filler — trimmed down to the
// exact shortfall at assembly time — is how a longer slice gets covered).
export async function generateGapFiller(projectId: string, index: number, prompt: string, referenceNames?: string[]): Promise<Block> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.lockedManifest) throw new Error("Project is not locked yet");

  const row = await getBlockRow(projectId, index);
  const videoGen = getVideoGenProvider();
  const { jobId } = await videoGen.generateClip({
    prompt,
    referenceImages: resolveReferenceImages(project.lockedManifest, referenceNames ?? row.attached_reference_names),
    durationSeconds: row.end_sec - row.start_sec,
    dimension: project.dimension,
  });

  const attempt: ClipAttempt = { path: "", createdAt: new Date().toISOString(), status: "running", jobId };
  const gapFillerAttempts = [...row.gap_filler_attempts, attempt];

  const { data, error } = await supabase
    .from("blocks")
    .update({ gap_filler_attempts: gapFillerAttempts, gap_filler_prompt: prompt })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function pollGapFillerStatus(projectId: string, index: number): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const attempts = row.gap_filler_attempts;
  const latest = attempts[attempts.length - 1];
  if (!latest || latest.status !== "running" || !latest.jobId) {
    return mapBlockRow(row);
  }

  const videoGen = getVideoGenProvider();
  const status = await videoGen.pollStatus(latest.jobId);

  if (status.status === "running" || status.status === "pending") {
    return mapBlockRow(row);
  }

  if (status.status === "failed") {
    latest.status = "failed";
    latest.error = status.error;
    const { data, error } = await supabase
      .from("blocks")
      .update({ gap_filler_attempts: attempts })
      .eq("project_id", projectId)
      .eq("index", index)
      .select()
      .single();
    if (error) throw error;
    return mapBlockRow(data as BlockRow);
  }

  const videoRes = await fetch(status.videoUrl as string, { headers: status.videoHeaders });
  if (!videoRes.ok) throw new Error(`Failed to download generated filler clip: ${videoRes.status}`);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const objectKey = assetPaths.blockClip(projectId, index, `gap-filler-attempt-${attempts.length}.mp4`);
  await uploadAsset(objectKey, buffer, "video/mp4");

  latest.status = "succeeded";
  latest.path = objectKey;
  try {
    latest.durationSeconds = await probeDurationSeconds(buffer, "mp4");
  } catch {
    // Same as the main clip: nice-to-have, never fail generation over it.
  }

  const { data, error } = await supabase
    .from("blocks")
    .update({ gap_filler_attempts: attempts })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

// Composes the block's current clip + the approved filler into ONE clip
// right now, immediately — the user should see the finished, filled-in
// result in this stage, not have it silently deferred to final assembly.
export async function approveGapFiller(
  projectId: string,
  index: number,
  trimSeconds?: number,
  position: "before" | "after" = "after"
): Promise<Block> {
  const row = await getBlockRow(projectId, index);
  const latestFiller = row.gap_filler_attempts[row.gap_filler_attempts.length - 1];
  if (!latestFiller || latestFiller.status !== "succeeded") {
    throw new Error("No succeeded gap-filler attempt to approve for this block");
  }
  const currentPath = currentClipPath(row);
  if (!currentPath) throw new Error("No main clip to fill for this block yet");

  const sliceDuration = row.end_sec - row.start_sec;
  const [{ buffer: currentBuffer }, { buffer: fillerBuffer }] = await Promise.all([
    downloadAsset(currentPath),
    downloadAsset(latestFiller.path),
  ]);
  const fillerActualDuration = await probeDurationSeconds(fillerBuffer, "mp4");
  let fillerDuration: number;
  if (trimSeconds != null) {
    // User picked an explicit length for this custom scene — clamp to what
    // the generated filler actually has; any remaining mismatch against the
    // slice is still safely handled by buildSyncedVideo()'s trim/pad net.
    fillerDuration = Math.max(0, Math.min(trimSeconds, fillerActualDuration));
  } else {
    const currentDuration = await probeDurationSeconds(currentBuffer, "mp4");
    fillerDuration = Math.max(0, sliceDuration - currentDuration);
  }
  const trimmedFiller = await trimVideoBuffer(fillerBuffer, 0, fillerDuration);
  const composedBuffer =
    position === "before"
      ? await concatVideoBuffers(trimmedFiller, currentBuffer)
      : await concatVideoBuffers(currentBuffer, trimmedFiller);

  const objectKey = assetPaths.blockClip(projectId, index, `composed-${Date.now()}.mp4`);
  await uploadAsset(objectKey, composedBuffer, "video/mp4");

  const attempt: ClipAttempt = {
    path: objectKey,
    createdAt: new Date().toISOString(),
    status: "succeeded",
    durationSeconds: await probeDurationSeconds(composedBuffer, "mp4").catch(() => sliceDuration),
  };
  const clipAttempts = [...row.clip_attempts, attempt];

  const { data, error } = await supabase
    .from("blocks")
    .update({
      clip_attempts: clipAttempts,
      approved_clip_path: objectKey,
      approved_gap_filler_path: latestFiller.path,
    })
    .eq("project_id", projectId)
    .eq("index", index)
    .select()
    .single();
  if (error) throw error;
  return mapBlockRow(data as BlockRow);
}

export async function rejectClip(projectId: string, index: number, newPrompt?: string): Promise<Block> {
  const updates: Record<string, unknown> = { approval_status: "prompt_approved" };
  if (newPrompt !== undefined) updates.veo_prompt = newPrompt;

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
