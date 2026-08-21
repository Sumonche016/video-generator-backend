import { assetPaths, uploadAsset } from "../storage/assetStorage.js";
import { getProject, saveProject, advanceStage } from "./project.service.js";
import type { WordTiming, Project } from "../models/index.js";

// Real shape produced by ElevenLabs' word-level transcript export — segments
// each carry their own words[], and words include whitespace-only entries
// as separate timed tokens between real words.
interface ElevenLabsWord {
  text: string;
  start_time: number;
  end_time: number;
}

interface ElevenLabsSegment {
  text: string;
  start_time: number;
  end_time: number;
  speaker?: { id: string; name: string };
  words: ElevenLabsWord[];
}

interface ElevenLabsTranscript {
  language_code: string | null;
  segments: ElevenLabsSegment[];
}

export function parseElevenLabsTranscript(json: unknown): WordTiming[] {
  const transcript = json as ElevenLabsTranscript;
  if (!Array.isArray(transcript?.segments)) {
    throw new Error("Transcript JSON does not have the expected ElevenLabs shape (missing segments[])");
  }

  const words: WordTiming[] = [];
  for (const segment of transcript.segments) {
    for (const w of segment.words ?? []) {
      if (w.text.trim().length === 0) continue; // skip whitespace-only tokens
      words.push({ word: w.text, start: w.start_time, end: w.end_time });
    }
  }
  words.sort((a, b) => a.start - b.start);
  return words;
}

export interface UploadVoiceoverInput {
  projectId: string;
  mp3: { buffer: Buffer; mimetype: string };
  transcriptJson: unknown;
}

export async function uploadVoiceover(input: UploadVoiceoverInput): Promise<Project> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Project not found");

  const words = parseElevenLabsTranscript(input.transcriptJson);
  if (words.length === 0) throw new Error("Transcript contains no words");
  const durationSeconds = words[words.length - 1].end;

  const mp3Key = assetPaths.voiceover(input.projectId, "voiceover.mp3");
  const transcriptKey = assetPaths.voiceover(input.projectId, "transcript.json");
  await uploadAsset(mp3Key, input.mp3.buffer, input.mp3.mimetype);
  await uploadAsset(
    transcriptKey,
    Buffer.from(JSON.stringify(input.transcriptJson)),
    "application/json"
  );

  project.voiceover = { mp3Path: mp3Key, transcriptPath: transcriptKey, durationSeconds };
  advanceStage(project, "VOICEOVER_UPLOADED");
  return saveProject(project);
}
