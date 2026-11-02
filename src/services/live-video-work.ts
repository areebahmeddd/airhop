// Live video work that outlives the mesh that started it: a stream's END still
// draining, and recordings being finished into the cache. The panic wipe waits
// for it before emptying the cache, so a recording finished a moment after the
// wipe began is not the one file that survives it.

const pending = new Set<Promise<unknown>>();

export function trackLiveVideoWork<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = (): void => {
    pending.delete(work);
  };
  work.then(done, done);
  return work;
}

export async function settleLiveVideoWork(): Promise<void> {
  await Promise.allSettled([...pending]);
}
