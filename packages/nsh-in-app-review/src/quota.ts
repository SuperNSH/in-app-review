/** How many requests the rolling window holds. */
const MAX_REQUESTS = 3;
/** The window's length: 365 days of seconds. */
const WINDOW = 365 * 24 * 3600;

/**
 * Decides how often a review may be asked for. Times are unix seconds: `record` at a successful
 * hand-over, `unrecord` to undo a recorded hand-over that failed.
 */
export interface QuotaTracker {
  /** Whether one more request fits the window at `now`. */
  canRequest(now: number): boolean;

  /** Counts one request at `now`, at a successful hand-over. */
  record(now: number): void;

  /** Removes the most recent record at `now`, undoing a hand-over that failed. */
  unrecord(now: number): void;
}

/**
 * The quota in memory: timestamps of past requests, at most three per rolling 365 days. A
 * client-side policy on top of the OS's own — it can only refuse more than the store, never
 * less, and it resets when the app's memory does.
 */
export interface MemoryQuotaTracker extends QuotaTracker {
  /** The tracker's current time, in unix seconds. */
  now(): number;
}

/** A memory quota on the system clock; `config.now` injects another, so tests inject theirs. */
export function memoryQuotaTracker(config: { now?: () => number } = {}): MemoryQuotaTracker {
  const clock = config.now ?? unixNow;
  let requests: number[] = [];
  // A timestamp leaves the window only by expiring; one exactly `WINDOW` old has left it.
  const inside = (times: number[], at: number): number[] => times.filter((time) => time > at - WINDOW);
  return {
    now: () => clock(),
    canRequest: (at) => {
      requests = inside(requests, at);
      return requests.length < MAX_REQUESTS;
    },
    record: (at) => {
      requests = inside(requests, at);
      requests.push(at);
    },
    unrecord: (at) => {
      // Only the newest entry at `at` goes: a same-second request keeps its own count.
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        if (requests[index] === at) {
          requests.splice(index, 1);
          return;
        }
      }
    },
  };
}

/** Seconds since the unix epoch. The quota counts in these. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
