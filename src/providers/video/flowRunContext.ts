import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { appendFlowLog, type FlowLogLevel } from "./flowLogBuffer.js";
import { abortReasonOf, isAborted } from "./flowRunRegistry.js";

// Several Flow runs render at the same time (one per GoLogin profile), and
// every one of them logs progress from the same shared helpers — page
// clicking, the AI fallback, the render wait. Without a per-run tag the
// streams interleave into what looks like a single confused run, so the run's
// identity is carried implicitly through async calls and stamped onto
// whatever those helpers log.
//
// The same context is what lets a log line be filed under the right job's
// buffer, and what lets any helper ask "has my run been stopped?" without
// threading a signal through every function signature.
export interface FlowRunContext {
  jobId: string;
  // Short, stable display tag used as the console prefix.
  label: string;
}

const runCtx = new AsyncLocalStorage<FlowRunContext>();

export function withFlowRun<T>(ctx: FlowRunContext, fn: () => Promise<T>): Promise<T> {
  return runCtx.run(ctx, fn);
}

export function currentFlowRun(): FlowRunContext | undefined {
  return runCtx.getStore();
}

// Thrown by the checkpoints below. The message is the registry's abort reason,
// so it is already user-facing.
export class FlowAbortError extends Error {
  readonly isFlowAbort = true;

  constructor(reason: string) {
    super(reason);
    this.name = "FlowAbortError";
  }
}

// Cooperative stop point. Closing the browser interrupts pending Playwright
// calls, but a run spends most of its wall-clock in things closing cannot
// touch — the render-wait loop's sleeps, the download, the LLM fallback call.
// Sprinkling these between steps is what makes a stop feel immediate.
export function throwIfAborted(): void {
  const ctx = runCtx.getStore();
  if (!ctx) return;
  if (isAborted(ctx.jobId)) throw new FlowAbortError(abortReasonOf(ctx.jobId) ?? "Stopped");
}

// setTimeout that gives up as soon as the run is aborted, so a stop during a
// two-second human pause does not wait it out.
export function abortableDelay(ms: number): Promise<void> {
  throwIfAborted();
  const ctx = runCtx.getStore();
  if (!ctx) return new Promise((resolve) => setTimeout(resolve, ms));

  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
    const timer = setTimeout(() => {
      settle();
      resolve();
    }, ms);
    // The registry holds the AbortController, but polling here keeps this
    // module free of any dependency on how the abort is delivered.
    const poll = setInterval(() => {
      if (!isAborted(ctx.jobId)) return;
      settle();
      reject(new FlowAbortError(abortReasonOf(ctx.jobId) ?? "Stopped"));
    }, 250);
  });
}

let installed = false;

// Wrapping console once is what lets untouched helper modules (and the
// gologin SDK's own "Profile has been uploaded to S3" chatter) come out
// labeled and captured, instead of threading a logger through every function.
export function installFlowLogPrefix(): void {
  if (installed) return;
  installed = true;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const ctx = runCtx.getStore();
      if (!ctx) {
        original(...args);
        return;
      }
      original(`[${ctx.label}]`, ...args);
      // Capturing must never be able to break a run, and must never log.
      try {
        appendFlowLog(ctx.jobId, level as FlowLogLevel, formatArgs(args));
      } catch {
        /* ignore */
      }
    };
  }
}

// Playwright and gologin hand console.warn objects with circular references,
// so inspect() rather than JSON.stringify.
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      return inspect(arg, { depth: 2, breakLength: Infinity });
    })
    .join(" ");
}
