import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function tmpFile(ext: string): Promise<string> {
  return path.join(os.tmpdir(), `vedit-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

// Cuts [startSec, startSec+durationSec) out of a clip buffer — used both for
// the user-initiated "Cut" action (trim unwanted footage) and for trimming a
// filler clip down to exactly the remaining shortfall before stitching it on.
export async function trimVideoBuffer(buffer: Buffer, startSec: number, durationSec: number): Promise<Buffer> {
  const inPath = await tmpFile("mp4");
  const outPath = await tmpFile("mp4");
  await fs.writeFile(inPath, buffer);
  try {
    const args = ["-y"];
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", inPath, "-t", String(Math.max(0, durationSec)), "-c", "copy", outPath);
    await execFileAsync("ffmpeg", args);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

// Same cut as trimVideoBuffer but frame-accurate: "-c copy" can only cut on
// the input's actual keyframe boundaries, so a short/sub-keyframe-interval
// trim (e.g. shaving a ~1-2s lead-in off a generated clip) can silently snap
// back to an earlier keyframe and cut far less than requested. Re-encoding
// instead makes the seek land on the exact requested frame. Used only where
// that precision actually matters — WanProvider's lead-in trim — not for
// the user-facing "Cut" action, which intentionally stays instant/lossless.
export async function trimVideoBufferPrecise(buffer: Buffer, startSec: number, durationSec: number): Promise<Buffer> {
  const inPath = await tmpFile("mp4");
  const outPath = await tmpFile("mp4");
  await fs.writeFile(inPath, buffer);
  try {
    const args = ["-y"];
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", inPath, "-t", String(Math.max(0, durationSec)), "-c:v", "libx264", "-c:a", "aac", outPath);
    await execFileAsync("ffmpeg", args);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

// Concatenates two clip buffers back-to-back (main clip + filler) into one
// file — used when the user approves a gap-filler to compose the final clip
// for a block immediately, rather than deferring composition to assembly.
export async function concatVideoBuffers(firstBuffer: Buffer, secondBuffer: Buffer): Promise<Buffer> {
  const firstPath = await tmpFile("mp4");
  const secondPath = await tmpFile("mp4");
  const listPath = await tmpFile("txt");
  const outPath = await tmpFile("mp4");
  await fs.writeFile(firstPath, firstBuffer);
  await fs.writeFile(secondPath, secondBuffer);
  try {
    await fs.writeFile(
      listPath,
      [firstPath, secondPath].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );
    await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(firstPath, { force: true });
    await fs.rm(secondPath, { force: true });
    await fs.rm(listPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}
