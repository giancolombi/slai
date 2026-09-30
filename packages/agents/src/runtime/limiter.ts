/** A FIFO semaphore: at most `max` tasks run at once. */
export function createLimiter(max: number) {
  if (!Number.isInteger(max) || max < 1) throw new Error("concurrency must be a positive integer");
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        next();
      });
    },
  };
}
