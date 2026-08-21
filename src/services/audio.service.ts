import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Measures mean loudness in dBFS via ffmpeg's volumedetect filter (silence =
// very negative, e.g. -91dB; typical speech/ambience sits around -15 to -25dB).
export async function measureVolumeDb(buffer: Buffer, extension: string): Promise<number> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "volcheck-"));
  try {
    const filePath = path.join(tmpDir, `audio.${extension}`);
    await fs.writeFile(filePath, buffer);
    const { stderr } = await execFileAsync("ffmpeg", ["-i", filePath, "-af", "volumedetect", "-f", "null", "-"]).catch(
      (err) => ({ stderr: err.stderr as string })
    );
    const match = /mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/.exec(stderr ?? "");
    if (!match) throw new Error("Could not parse mean_volume from ffmpeg output");
    return parseFloat(match[1]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Re-encodes just the audio track at the given linear gain factor (e.g. 0.5
// = half volume/-6dB), keeping video untouched (stream-copied).
export async function applyAudioGain(buffer: Buffer, gainFactor: number): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "duck-"));
  try {
    const inputPath = path.join(tmpDir, "in.mp4");
    const outputPath = path.join(tmpDir, "out.mp4");
    await fs.writeFile(inputPath, buffer);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-af", `volume=${gainFactor}`,
      "-c:v", "copy",
      "-c:a", "aac",
      outputPath,
    ]);
    return fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
