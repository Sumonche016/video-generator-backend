import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supabase } from "./../storage/supabaseClient.js";
import { assetPaths, downloadAsset, uploadAsset, getSignedAssetUrl } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage } from "./project.service.js";
import { writeSrtFile, burnSubtitles, type SubtitleStyle } from "./subtitle.service.js";
import { parseElevenLabsTranscript } from "./voiceover.service.js";
import { probeDurationSeconds } from "./ffprobe.service.js";
import type { Block } from "../models/index.js";

const execFileAsync = promisify(execFile);

interface BlockRow {
  index: number;
  start_sec: number;
  end_sec: number;
  approval_status: Block["approvalStatus"];
  approved_clip_path: string | null;
  clip_attempts: { path: string; status: string }[];
  approved_gap_filler_path: string | null;
}

export class AssembleValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot assemble final video: ${issues.join("; ")}`);
    this.name = "AssembleValidationError";
  }
}

// Builds one muxed mp4 from a list of (video clip, matching voiceover slice)
// pairs — used for both the full final export and the quick preview merge.
// Slicing the voiceover per-block (rather than overlaying the whole file
// once) is what keeps video and narration in sync even when the blocks are
// a partial or non-contiguous subset: each clip only ever plays against its
// own [startSec, endSec) of narration, so skipped blocks just shrink both
// tracks together instead of leaving a sync-breaking gap.
async function buildSyncedVideo(
  voiceoverPath: string,
  blocks: { index: number; startSec: number; endSec: number; clipPath: string; gapFillerPath?: string | null }[],
  tmpDir: string
): Promise<string> {
  const clipLocalPaths: string[] = [];
  const audioSegmentPaths: string[] = [];

  for (const b of blocks) {
    const sliceDuration = b.endSec - b.startSec;
    const { buffer } = await downloadAsset(b.clipPath);
    const rawClipPath = path.join(tmpDir, `clip-raw-${b.index}.mp4`);
    await fs.writeFile(rawClipPath, buffer);

    // Veo always returns a fixed-length clip (~8s) regardless of what was
    // requested, so every block's segment is force-fit to exactly its
    // voiceover slice length here — otherwise a single mismatched block
    // would drift video-vs-audio sync for every block after it, since the
    // video and audio tracks are concatenated independently below.
    const clipLocalPath = path.join(tmpDir, `clip-${b.index}.mp4`);
    const actualDuration = await probeDurationSeconds(buffer, "mp4").catch(() => sliceDuration);

    if (actualDuration >= sliceDuration) {
      await execFileAsync("ffmpeg", ["-y", "-i", rawClipPath, "-t", String(sliceDuration), "-c", "copy", clipLocalPath]);
    } else {
      const shortfall = sliceDuration - actualDuration;
      if (b.gapFillerPath) {
        const { buffer: fillerBuffer } = await downloadAsset(b.gapFillerPath);
        const rawFillerPath = path.join(tmpDir, `filler-raw-${b.index}.mp4`);
        await fs.writeFile(rawFillerPath, fillerBuffer);
        const trimmedFillerPath = path.join(tmpDir, `filler-${b.index}.mp4`);
        await execFileAsync("ffmpeg", ["-y", "-i", rawFillerPath, "-t", String(shortfall), "-c", "copy", trimmedFillerPath]);

        const concatListPath = path.join(tmpDir, `clip-filler-concat-${b.index}.txt`);
        await fs.writeFile(
          concatListPath,
          [rawClipPath, trimmedFillerPath].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
        );
        await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", clipLocalPath]);
      } else {
        await execFileAsync("ffmpeg", [
          "-y",
          "-i", rawClipPath,
          "-vf", `tpad=stop_mode=clone:stop_duration=${shortfall}`,
          clipLocalPath,
        ]);
      }
    }
    clipLocalPaths.push(clipLocalPath);

    const segmentPath = path.join(tmpDir, `voiceover-${b.index}.mp3`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", voiceoverPath,
      "-ss", String(b.startSec),
      "-to", String(b.endSec),
      "-c", "copy",
      segmentPath,
    ]);
    audioSegmentPaths.push(segmentPath);
  }

  const videoConcatListPath = path.join(tmpDir, "video-concat.txt");
  await fs.writeFile(
    videoConcatListPath,
    clipLocalPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  const concatenatedVideoPath = path.join(tmpDir, "concatenated-video.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", videoConcatListPath,
    "-c", "copy",
    concatenatedVideoPath,
  ]);

  const audioConcatListPath = path.join(tmpDir, "audio-concat.txt");
  await fs.writeFile(
    audioConcatListPath,
    audioSegmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  const concatenatedAudioPath = path.join(tmpDir, "concatenated-audio.mp3");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", audioConcatListPath,
    "-c", "copy",
    concatenatedAudioPath,
  ]);

  const outputPath = path.join(tmpDir, "output.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", concatenatedVideoPath,
    "-i", concatenatedAudioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);

  return outputPath;
}

// Burns captions onto an already-assembled video as a distinct final pass,
// driven by the project's full voiceover transcript (already in the final
// video's absolute timeline, so no per-block offsetting is needed). Kept
// separate from buildSyncedVideo so a captioning fix only re-runs this
// cheap step instead of re-downloading clips / re-slicing audio / re-concat.
async function applySubtitles(
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>,
  videoPath: string,
  tmpDir: string,
  style?: SubtitleStyle
): Promise<string> {
  if (!project.voiceover) return videoPath;

  const { buffer } = await downloadAsset(project.voiceover.transcriptPath);
  const words = parseElevenLabsTranscript(JSON.parse(buffer.toString("utf-8")));

  const srtPath = path.join(tmpDir, "captions.srt");
  await writeSrtFile(words, srtPath);

  const subtitledPath = path.join(tmpDir, "output_with_subs.mp4");
  await burnSubtitles(videoPath, srtPath, subtitledPath, style);
  return subtitledPath;
}

export async function assembleProject(
  projectId: string,
  options?: { burnSubtitles?: boolean; subtitleStyle?: SubtitleStyle }
): Promise<{ project: Awaited<ReturnType<typeof saveProject>>; skippedBlockIndices: number[] }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.voiceover) throw new Error("No voiceover uploaded");

  const { data: rows, error } = await supabase
    .from("blocks")
    .select("index, start_sec, end_sec, approval_status, approved_clip_path, clip_attempts, approved_gap_filler_path")
    .eq("project_id", projectId)
    .order("index");
  if (error) throw error;

  const allBlocks = rows as BlockRow[];
  const approvedBlocks = allBlocks.filter((b) => b.approval_status === "approved" && b.approved_clip_path);
  const skippedBlockIndices = allBlocks
    .filter((b) => !(b.approval_status === "approved" && b.approved_clip_path))
    .map((b) => b.index);

  if (allBlocks.length === 0) throw new AssembleValidationError(["No blocks planned yet"]);
  if (approvedBlocks.length === 0) {
    throw new AssembleValidationError(["No approved scenes to assemble yet — approve at least one scene first"]);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-"));
  try {
    const { buffer: voiceoverBuffer } = await downloadAsset(project.voiceover.mp3Path);
    const voiceoverPath = path.join(tmpDir, "voiceover.mp3");
    await fs.writeFile(voiceoverPath, voiceoverBuffer);

    let outputPath = await buildSyncedVideo(
      voiceoverPath,
      approvedBlocks.map((b) => ({
        index: b.index,
        startSec: b.start_sec,
        endSec: b.end_sec,
        clipPath: b.approved_clip_path as string,
        gapFillerPath: b.approved_gap_filler_path,
      })),
      tmpDir
    );

    if (options?.burnSubtitles) {
      outputPath = await applySubtitles(project, outputPath, tmpDir, options.subtitleStyle);
    }

    const finalBuffer = await fs.readFile(outputPath);
    const filename = `output-${project.dimension}-${Date.now()}.mp4`;
    const objectKey = assetPaths.final(projectId, filename);
    await uploadAsset(objectKey, finalBuffer, "video/mp4");

    project.finalOutputPath = objectKey;
    advanceStage(project, "ASSEMBLED");
    const saved = await saveProject(project);
    return { project: saved, skippedBlockIndices };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Quick sanity-check merge of whatever clips have been generated so far —
// unlike assembleProject, this does NOT require every block to be approved.
// Plays the real voiceover synced to whichever scenes are shown (sliced
// per-block, same as the final export), not each clip's own raw audio.
export async function mergePreviewClips(
  projectId: string,
  options?: { burnSubtitles?: boolean; subtitleStyle?: SubtitleStyle }
): Promise<{ url: string; mergedCount: number }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.voiceover) throw new Error("No voiceover uploaded");

  const { data: rows, error } = await supabase
    .from("blocks")
    .select("index, start_sec, end_sec, approval_status, approved_clip_path, clip_attempts, approved_gap_filler_path")
    .eq("project_id", projectId)
    .order("index");
  if (error) throw error;

  const blocks: { index: number; startSec: number; endSec: number; clipPath: string; gapFillerPath?: string | null }[] = [];
  for (const row of rows as BlockRow[]) {
    if (row.approval_status !== "clip_review" && row.approval_status !== "approved") continue;
    const latestSucceeded = [...row.clip_attempts].reverse().find((a) => a.status === "succeeded");
    const clipPath = row.approved_clip_path ?? latestSucceeded?.path;
    if (clipPath) {
      blocks.push({
        index: row.index,
        startSec: row.start_sec,
        endSec: row.end_sec,
        clipPath,
        gapFillerPath: row.approved_gap_filler_path,
      });
    }
  }

  if (blocks.length === 0) throw new Error("No generated clips to merge yet");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-preview-"));
  try {
    const { buffer: voiceoverBuffer } = await downloadAsset(project.voiceover.mp3Path);
    const voiceoverPath = path.join(tmpDir, "voiceover.mp3");
    await fs.writeFile(voiceoverPath, voiceoverBuffer);

    let outputPath = await buildSyncedVideo(voiceoverPath, blocks, tmpDir);

    if (options?.burnSubtitles) {
      outputPath = await applySubtitles(project, outputPath, tmpDir, options.subtitleStyle);
    }

    const buffer = await fs.readFile(outputPath);
    const objectKey = assetPaths.preview(projectId, `preview-${Date.now()}.mp4`);
    await uploadAsset(objectKey, buffer, "video/mp4");

    return { url: await getSignedAssetUrl(objectKey), mergedCount: blocks.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function getFinalVideoUrl(projectId: string): Promise<string | null> {
  const project = await getProject(projectId);
  if (!project?.finalOutputPath) return null;
  return getSignedAssetUrl(project.finalOutputPath);
}
