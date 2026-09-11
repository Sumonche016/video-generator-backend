// Tracks every in-flight Flow run so it can be stopped — by the user, or by
// a watchdog when it overruns.
//
// A run exists from the moment generateClip is called, which is before it has
// a profile or a browser: a batch of 5 clips against 2 profiles leaves 3 runs
// parked on the profile pool with nothing to close. Stopping one of those has
// to work too, so the registry models "queued" as a first-class phase and
// carries an AbortController that the pool wait listens to.
//
// This module must not import FlowProvider (which imports it).

import { env } from "../../config/env.js";

export type FlowRunPhase = "queued" | "running" | "done";

interface FlowRun {
  jobId: string;
  phase: FlowRunPhase;
  registeredAt: number;
  acquiredAt: number | null;
  profileId: string | null;
  profileIndex: number | null;
  controller: AbortController;
  // Only set once the browser is actually up. Closing it is what makes
  // in-flight Playwright calls reject immediately.
  close: (() => Promise<void>) | null;
  // Set the moment an abort is requested. This — not the error that happens
  // to surface — is the source of truth for why a run ended.
  abortReason: string | null;
  queueWatchdog: NodeJS.Timeout | null;
  runWatchdog: NodeJS.Timeout | null;
}

const runs = new Map<string, FlowRun>();

export function registerFlowRun(jobId: string): AbortController {
  const controller = new AbortController();
  const run: FlowRun = {
    jobId,
    phase: "queued",
    registeredAt: Date.now(),
    acquiredAt: null,
    profileId: null,
    profileIndex: null,
    controller,
    close: null,
    abortReason: null,
    queueWatchdog: null,
    runWatchdog: null,
  };

  // Covers a run that never gets a profile at all.
  run.queueWatchdog = setTimeout(() => {
    abortFlowRun(
      jobId,
      `Gave up after waiting ${Math.round(env.FLOW_QUEUE_TIMEOUT_MS / 1000)}s for a free profile`
    );
  }, env.FLOW_QUEUE_TIMEOUT_MS);
  // Never let a watchdog hold the process open.
  run.queueWatchdog.unref();

  runs.set(jobId, run);
  return controller;
}

export function markAcquired(jobId: string, profileId: string, profileIndex: number): void {
  const run = runs.get(jobId);
  if (!run) return;

  run.phase = "running";
  run.acquiredAt = Date.now();
  run.profileId = profileId;
  run.profileIndex = profileIndex;

  if (run.queueWatchdog) {
    clearTimeout(run.queueWatchdog);
    run.queueWatchdog = null;
  }

  // The real ceiling starts now: time spent queueing is not the run's fault.
  run.runWatchdog = setTimeout(() => {
    abortFlowRun(
      jobId,
      `Timed out after ${Math.round(env.FLOW_RUN_TIMEOUT_MS / 1000)}s (auto-stopped)`
    );
  }, env.FLOW_RUN_TIMEOUT_MS);
  run.runWatchdog.unref();
}

export function attachClose(jobId: string, close: () => Promise<void>): void {
  const run = runs.get(jobId);
  if (!run) return;
  run.close = close;

  // An abort that landed between acquiring the profile and the browser coming
  // up had nothing to close at the time, so close it now.
  if (run.abortReason) void close().catch(() => undefined);
}

export function abortFlowRun(jobId: string, reason: string): boolean {
  const run = runs.get(jobId);
  if (!run || run.phase === "done") return false;
  // First abort wins — a user stop during the watchdog's grace should keep
  // saying "Stopped by user".
  if (run.abortReason) return true;

  run.abortReason = reason;
  run.controller.abort();

  // Tearing the browser down is what interrupts whatever Playwright call the
  // run is parked on. Not awaited: goLogin.stop() syncs the whole profile to
  // S3 and can take a long time, and the run's own teardown path will also
  // await it (close is idempotent).
  if (run.close) void run.close().catch(() => undefined);

  return true;
}

export function isAborted(jobId: string): boolean {
  return runs.get(jobId)?.abortReason != null;
}

export function abortReasonOf(jobId: string): string | null {
  return runs.get(jobId)?.abortReason ?? null;
}

export function finishFlowRun(jobId: string): void {
  const run = runs.get(jobId);
  if (!run) return;

  run.phase = "done";
  if (run.queueWatchdog) clearTimeout(run.queueWatchdog);
  if (run.runWatchdog) clearTimeout(run.runWatchdog);

  // Keep nothing around: the abort reason has already been folded into the
  // provider's stored result by the time this is called.
  runs.delete(jobId);
}
