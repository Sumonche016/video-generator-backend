// Runs async tasks one at a time, in call order. Used to serialize
// gpt-image-1 calls so multiple "Generate" clicks queue up instead of
// bursting past OpenAI's per-minute image rate limit all at once.
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    // Swallow errors here so one failed task doesn't break the chain for
    // tasks queued after it — the caller's own promise still rejects.
    tail = run.catch(() => undefined);
    return run;
  };
}
