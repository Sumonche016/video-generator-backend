import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WordTiming } from "../models/index.js";

const execFileAsync = promisify(execFile);

const MAX_WORDS_PER_LINE = 6;
const MAX_LINE_DURATION_SECONDS = 4;

interface CaptionLine {
  start: number;
  end: number;
  text: string;
}

function groupWordsIntoLines(words: WordTiming[]): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: WordTiming[] = [];

  for (const word of words) {
    const wouldExceedDuration =
      current.length > 0 && word.end - current[0].start > MAX_LINE_DURATION_SECONDS;
    if (current.length >= MAX_WORDS_PER_LINE || wouldExceedDuration) {
      lines.push(toLine(current));
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) lines.push(toLine(current));

  return lines;
}

function toLine(words: WordTiming[]): CaptionLine {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(" ").trim(),
  };
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function buildSrtContent(words: WordTiming[]): string {
  const lines = groupWordsIntoLines(words.filter((w) => w.word.trim().length > 0));
  return lines
    .map(
      (line, i) =>
        `${i + 1}\n${formatSrtTimestamp(line.start)} --> ${formatSrtTimestamp(line.end)}\n${line.text}\n`
    )
    .join("\n");
}

export async function writeSrtFile(words: WordTiming[], outPath: string): Promise<void> {
  await fs.writeFile(outPath, buildSrtContent(words), "utf-8");
}

// ffmpeg's subtitles filter requires escaping ':' and '\' in the path and
// on Windows needs drive-letter colons escaped too, so pass a POSIX-ish
// forward-slash path and escape remaining colons.
function escapeSubtitlesFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export interface SubtitleStyle {
  fontName?: string;
  fontSize?: number;
  primaryColor?: string; // ASS &HBBGGRR& format, e.g. "&HFFFFFF&"
  outlineColor?: string;
  backColor?: string; // ASS &HAABBGGRR& format, e.g. "&H80000000&" (semi-transparent black box)
  bold?: boolean;
  alignment?: number; // ASS \an alignment (2 = bottom-center)
  marginV?: number;
}

function buildForceStyle(style: SubtitleStyle | undefined): string {
  const s: Required<SubtitleStyle> = {
    fontName: style?.fontName ?? "Arial",
    fontSize: style?.fontSize ?? 22,
    primaryColor: style?.primaryColor ?? "&H00FFFFFF&",
    outlineColor: style?.outlineColor ?? "&H00111111&",
    backColor: style?.backColor ?? "&H80000000&",
    bold: style?.bold ?? true,
    alignment: style?.alignment ?? 2,
    marginV: style?.marginV ?? 35,
  };

  return [
    `FontName=${s.fontName}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${s.primaryColor}`,
    `OutlineColour=${s.outlineColor}`,
    `BackColour=${s.backColor}`,

    // Clean subtitle style
    `BorderStyle=1`,
    `Outline=2`,
    `Shadow=1`,

    `Bold=${s.bold ? 1 : 0}`,
    `Alignment=${s.alignment}`,
    `MarginV=${s.marginV}`,
  ].join(",");
}

export async function burnSubtitles(
  inputVideoPath: string,
  srtPath: string,
  outputVideoPath: string,
  style?: SubtitleStyle
): Promise<void> {
  const filterPath = escapeSubtitlesFilterPath(srtPath);
  const forceStyle = buildForceStyle(style);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputVideoPath,
    "-vf", `subtitles='${filterPath}':force_style='${forceStyle}'`,
    "-c:a", "copy",
    outputVideoPath,
  ]);
}
