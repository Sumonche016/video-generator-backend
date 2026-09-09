import { env } from "../../config/env.js";

// The Flow provider drives a real browser for a whole clip, so the number
// of clips that can be generated at once is exactly the number of GoLogin
// profiles (= logged-in Google accounts) available. Two profiles means two
// clips render side by side; three means three. Anything beyond that waits
// for a profile to come free rather than piling extra Orbita browsers onto
// the same account.
function parseProfileIds(): string[] {
  const ids = [
    ...(env.GOLOGIN_PROFILE_IDS ?? "").split(","),
    env.GOLOGIN_PROFILE_ID ?? "",
  ]
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  // Same profile listed twice would mean two runs fighting over one locked
  // profile, so collapse duplicates.
  return [...new Set(ids)];
}

export function getFlowProfileIds(): string[] {
  return parseProfileIds();
}

type Slot = { profileId: string; index: number };
type Waiter = (slot: Slot) => void;

// A profile is either idle (in `available`) or checked out by a run. Runs
// that arrive with nothing free queue up in `waiters` in call order, so a
// batch of 5 with 3 profiles runs 3 now and the remaining 2 as slots free.
const available: Slot[] = [];
const waiters: Waiter[] = [];
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  const ids = parseProfileIds();
  if (ids.length === 0) {
    throw new Error(
      "GOLOGIN_PROFILE_IDS (or GOLOGIN_PROFILE_ID) must be set to use the Flow video provider"
    );
  }
  available.push(...ids.map((profileId, index) => ({ profileId, index: index + 1 })));
  initialized = true;
}

// "3 profile(s), 1 idle, 2 clip(s) waiting" — makes it obvious from the log
// whether a batch is actually running in parallel or queued behind profiles.
export function describeFlowPool(): string {
  const total = parseProfileIds().length;
  const idle = initialized ? available.length : total;
  return `${total} profile(s), ${idle} idle, ${waiters.length} clip(s) waiting`;
}

export async function acquireFlowProfile(): Promise<{
  profileId: string;
  // 1-based position in the configured list, used to label this run's logs
  // so three concurrent runs stay readable.
  profileIndex: number;
  release: () => void;
}> {
  ensureInitialized();

  const slot = available.shift() ?? (await new Promise<Slot>((resolve) => waiters.push(resolve)));

  let released = false;
  const release = () => {
    // Guard against a double release handing the same profile to two runs.
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next(slot);
    else available.push(slot);
  };

  return { profileId: slot.profileId, profileIndex: slot.index, release };
}
