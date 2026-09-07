export function createCoalescedWriter(write, delay = 200, timers = {}) {
  const schedule = timers.schedule ?? setTimeout;
  const cancelTimer = timers.cancel ?? clearTimeout;
  let timer = null;
  let pending;
  const flush = () => {
    if (timer !== null) cancelTimer(timer);
    timer = null;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    write(value);
  };
  return {
    queue(value) {
      pending = value;
      if (timer !== null) cancelTimer(timer);
      timer = schedule(flush, delay);
    },
    flush,
    cancel() {
      if (timer !== null) cancelTimer(timer);
      timer = null;
      pending = undefined;
    },
  };
}
