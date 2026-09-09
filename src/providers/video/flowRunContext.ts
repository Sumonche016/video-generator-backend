import { AsyncLocalStorage } from "node:async_hooks";

// Several Flow runs render at the same time (one per GoLogin profile), and
// every one of them logs progress from the same shared helpers — page
// clicking, the AI fallback, the render wait. Without a per-run tag the
// three streams interleave into what looks like a single confused run, so
// the run's label is carried implicitly through async calls and stamped
// onto whatever those helpers log.
const runLabel = new AsyncLocalStorage<string>();

export function withFlowRunLabel<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runLabel.run(label, fn);
}

let installed = false;

// Wrapping console once is what lets untouched helper modules (and the
// gologin SDK's own "Profile has been uploaded to S3" chatter) come out
// labeled, instead of threading a logger through every function.
export function installFlowLogPrefix(): void {
  if (installed) return;
  installed = true;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const label = runLabel.getStore();
      if (label) original(`[${label}]`, ...args);
      else original(...args);
    };
  }
}
