/** Bound a local wait without allowing its late result to resume the caller. */
export function boundedOperation<T>(operation: Promise<T>, timeoutMs = 2000, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const complete = (callback: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback();
    };
    const aborted = () => complete(() => reject(signal?.reason ?? new Error('Cancelled')));
    const timer = setTimeout(() => complete(() => reject(new Error('PAGE_PROBE_TIMEOUT'))), timeoutMs);
    operation.then(value => complete(() => resolve(value)), error => complete(() => reject(error)));
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}
