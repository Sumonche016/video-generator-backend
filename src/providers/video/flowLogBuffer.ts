// Per-run log capture for Flow generations.
//
// The browser automation is the one part of the pipeline a user cannot see,
// so everything it logs is kept in a small in-memory ring buffer keyed by
// job id and served to the UI through a cursor poll. Buffers are deliberately
// kept after a run finishes — a failed run's log is the diagnostic, and the
// user only goes looking for it once the block has already turned red.
//
// IMPORTANT: nothing in this module may call console.*. It is written to from
// inside the console tap installed by flowRunContext, so a log call here would
// recurse forever.

export type FlowLogLevel = "log" | "warn" | "error";

export interface FlowLogEntry {
  // Monotonic per job, starting at 1. Doubles as the read cursor.
  seq: number;
  ts: number;
  level: FlowLogLevel;
  // Whether this line survives the default (curated) view — see classify().
  important: boolean;
  message: string;
}

export interface FlowLogPage {
  entries: FlowLogEntry[];
  nextCursor: number;
  // How many lines aged out of the ring before the reader got to them, so the
  // panel can say "N earlier lines dropped" instead of silently lying.
  dropped: number;
  finished: boolean;
}

// How long a finished run's results and logs are kept. Shared with
// FlowProvider so the two retentions can never drift apart.
export const RESULT_RETENTION_MS = 30 * 60 * 1000;

// A run logs on the order of 100 lines; 400 leaves room for a pathological
// one (the render wait heartbeats every 15s for up to 5 minutes) without
// letting a single job pin much memory.
const PER_JOB_CAP = 400;
// The "still waiting for the clip" line carries a tab list and can get long.
const MAX_MESSAGE_CHARS = 2000;
// Bounds total memory across retries in a long-lived process.
const MAX_BUFFERS = 50;

interface Buffer {
  entries: FlowLogEntry[];
  nextSeq: number;
  dropped: number;
  finishedAt: number | null;
}

const buffers = new Map<string, Buffer>();

// Lines that every single run produces and that tell the user nothing about
// whether their clip is progressing.
const NOISE: RegExp[] = [
  // The attach-panel helper tries three strategies in order and warns on each
  // one that misses, so a healthy run still logs two of these. Anchored on
  // "strategy " so it does not swallow the `opened via "..."` success line.
  /^openAttachMediaPanel: strategy /,
  /debug screenshot/i,
  /saved page HTML/i,
  /goLoginClient: FLOW_BROWSER_MODE=/,
  // gologin SDK chatter.
  /Profile has been uploaded to S3/,
  /Download completed|Extracting Orbita|Copy Orbita to target path/,
];

// The beats of a run a user actually wants to watch.
const SIGNAL: RegExp[] = [
  /starting .* on profile /,
  /queued /,
  /waiting for a profile/,
  // Both word orders occur: "pasting the prompt (N chars)", "prompt pasted",
  // "submitted the prompt (Enter)".
  /prompt (pasted|submitted)/i,
  /(pasting|submitted|filling) the prompt/i,
  // The success line from the attach-panel helper, whose failed attempts are
  // filtered as noise above.
  /^openAttachMediaPanel: opened via /,
  /render progress /,
  /rendered/,
  /MB of video/,
  /downloading the clip/,
  /succeeded after|failed after/,
  /stored clip/,
  /stopped by user/i,
  /not signed in/i,
  /attaching \d+ reference image/,
  /run finished/,
];

// Everything is captured; this only decides what the panel shows before the
// user asks for the full firehose. Errors are always important.
export function classify(level: FlowLogLevel, message: string): boolean {
  if (NOISE.some((re) => re.test(message))) return false;
  if (level === "error" || level === "warn") return true;
  return SIGNAL.some((re) => re.test(message));
}

export function createFlowLogBuffer(jobId: string): void {
  buffers.set(jobId, { entries: [], nextSeq: 1, dropped: 0, finishedAt: null });
  evictOldestIfNeeded();
}

export function appendFlowLog(jobId: string, level: FlowLogLevel, message: string): void {
  const buffer = buffers.get(jobId);
  if (!buffer) return;

  const trimmed =
    message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;

  buffer.entries.push({
    seq: buffer.nextSeq++,
    ts: Date.now(),
    level,
    important: classify(level, trimmed),
    message: trimmed,
  });

  while (buffer.entries.length > PER_JOB_CAP) {
    buffer.entries.shift();
    buffer.dropped += 1;
  }
}

export function readFlowLog(jobId: string, since: number, includeAll: boolean): FlowLogPage {
  const buffer = buffers.get(jobId);
  if (!buffer) {
    // A restart (or a job older than the retention window) loses the buffer.
    // Report it as finished so the client stops polling rather than erroring.
    return { entries: [], nextCursor: since, dropped: 0, finished: true };
  }

  const fresh = buffer.entries.filter((entry) => entry.seq > since);
  const entries = includeAll ? fresh : fresh.filter((entry) => entry.important);

  return {
    entries,
    // Cursor advances past everything seen, not just what was returned, so
    // filtering never causes the same suppressed lines to be rescanned.
    nextCursor: fresh.length ? fresh[fresh.length - 1].seq : since,
    dropped: buffer.dropped,
    finished: buffer.finishedAt !== null,
  };
}

// Stamps the buffer as done so retention can start. Deliberately does NOT
// delete it: the profile teardown keeps logging for a while after this, and
// the user typically opens the log only once the run has ended.
export function finishFlowLogBuffer(jobId: string): void {
  const buffer = buffers.get(jobId);
  if (buffer) buffer.finishedAt = Date.now();
}

export function pruneFlowLogBuffers(): void {
  const cutoff = Date.now() - RESULT_RETENTION_MS;
  for (const [jobId, buffer] of buffers) {
    if (buffer.finishedAt !== null && buffer.finishedAt < cutoff) buffers.delete(jobId);
  }
}

function evictOldestIfNeeded(): void {
  if (buffers.size <= MAX_BUFFERS) return;

  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [jobId, buffer] of buffers) {
    // Only finished runs are eligible — never evict a live run's log.
    if (buffer.finishedAt !== null && buffer.finishedAt < oldestAt) {
      oldestAt = buffer.finishedAt;
      oldestId = jobId;
    }
  }
  if (oldestId) buffers.delete(oldestId);
}
