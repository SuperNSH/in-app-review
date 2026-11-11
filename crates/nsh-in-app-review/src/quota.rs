//! The client-side quota: at most three requests per rolling 365 days, counted in memory.

use std::{
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

/// How many requests the rolling window holds.
const MAX_REQUESTS: usize = 3;
/// The window's length: 365 days of seconds.
const WINDOW: i64 = 365 * 24 * 3600;

/// Decides how often a review may be asked for. Times are unix seconds: `record` at a successful
/// hand-over, `unrecord` to undo a recorded hand-over that failed.
pub trait QuotaTracker: Send + Sync {
    /// Whether one more request fits the window at `now`.
    fn can_request(&self, now: i64) -> bool;

    /// Counts one request at `now`, at a successful hand-over.
    fn record(&self, now: i64);

    /// Removes the most recent record at `now`, undoing a hand-over that failed.
    fn unrecord(&self, now: i64);
}

/// The quota in memory: timestamps of past requests, at most [`MAX_REQUESTS`] per rolling
/// [`WINDOW`]. A client-side policy on top of the OS's own — it can only refuse more than the
/// store, never less, and it resets when the app's memory does.
pub struct MemoryQuotaTracker {
    requests: Mutex<Vec<i64>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl MemoryQuotaTracker {
    /// A tracker with the system clock.
    pub fn new() -> Self {
        Self::with_clock(Arc::new(unix_now))
    }

    /// A tracker whose time `clock` tells, so tests inject theirs.
    pub fn with_clock(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            clock,
        }
    }

    /// The tracker's current time, in unix seconds.
    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<i64>> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drops the timestamps that left the window at `now`.
    fn expire(&self, times: &mut Vec<i64>, now: i64) {
        times.retain(|&t| t > now - WINDOW);
    }
}

impl Default for MemoryQuotaTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaTracker for MemoryQuotaTracker {
    fn can_request(&self, now: i64) -> bool {
        let mut times = self.lock();
        self.expire(&mut times, now);
        times.len() < MAX_REQUESTS
    }

    fn record(&self, now: i64) {
        let mut times = self.lock();
        self.expire(&mut times, now);
        times.push(now);
    }

    fn unrecord(&self, now: i64) {
        let mut times = self.lock();
        // Only the newest entry at `now` goes: a same-second request keeps its own count.
        if let Some(last) = times.iter().rposition(|&t| t == now) {
            times.remove(last);
        }
    }
}

/// Seconds since the unix epoch; 0 before it. The quota counts in these.
pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
