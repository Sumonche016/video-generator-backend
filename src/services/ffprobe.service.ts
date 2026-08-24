import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Measures the real duration of a video/audio buffer. Needed because Veo
// ignores the requested clip duration and always returns a fixed-length
// clip (~8s) — nothing else in the pipeline knows the actual length unless
// we probe it ourselves after download.
export async function probeDurationSeconds(buffer: Buffer, ext: string): Promise<number> {
  const tmpPath = path.join(os.tmpdir(), `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.writeFile(tmpPath, buffer);
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      tmpPath,
    ]);
    return parseFloat(stdout.trim());
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}
