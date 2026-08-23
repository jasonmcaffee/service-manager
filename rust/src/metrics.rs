use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

/// Low-cardinality native metrics for readiness, requests, lifecycle actions, and reconciliation.
pub struct Metrics {
    started_at: Instant,
    ready: AtomicBool,
    requests: AtomicU64,
    errors: AtomicU64,
    starts: AtomicU64,
    stops: AtomicU64,
    restarts: AtomicU64,
    reconcile_ticks: AtomicU64,
    reconcile_errors: AtomicU64,
}

impl Metrics {
    /// Creates an unready metric set at process start.
    pub fn new() -> Self {
        Self { started_at: Instant::now(), ready: AtomicBool::new(false), requests: AtomicU64::new(0), errors: AtomicU64::new(0), starts: AtomicU64::new(0), stops: AtomicU64::new(0), restarts: AtomicU64::new(0), reconcile_ticks: AtomicU64::new(0), reconcile_errors: AtomicU64::new(0) }
    }

    /// Updates the readiness gauge after initialization completes or fails.
    pub fn set_ready(&self, value: bool) { self.ready.store(value, Ordering::Relaxed); }
    /// Returns the current readiness state without blocking request handling.
    pub fn is_ready(&self) -> bool { self.ready.load(Ordering::Relaxed) }
    /// Counts one HTTP request across API, operational, and static routes.
    pub fn note_request(&self) { self.requests.fetch_add(1, Ordering::Relaxed); }
    /// Counts one HTTP response with a client or server error status.
    pub fn note_error(&self) { self.errors.fetch_add(1, Ordering::Relaxed); }
    /// Counts one successful service start dispatch.
    pub fn note_start(&self) { self.starts.fetch_add(1, Ordering::Relaxed); }
    /// Counts one successful deliberate service stop.
    pub fn note_stop(&self) { self.stops.fetch_add(1, Ordering::Relaxed); }
    /// Counts one successful restart sequence in addition to its start and stop.
    pub fn note_restart(&self) { self.restarts.fetch_add(1, Ordering::Relaxed); }
    /// Counts one completed reconciliation pass.
    pub fn note_reconcile(&self) { self.reconcile_ticks.fetch_add(1, Ordering::Relaxed); }
    /// Counts one reconciliation pass that failed before completion.
    pub fn note_reconcile_error(&self) { self.reconcile_errors.fetch_add(1, Ordering::Relaxed); }

    /// Renders Prometheus-compatible scalar metrics without unbounded labels.
    pub fn render(&self, tracked: usize, running: usize) -> String {
        format!(
            "# TYPE service_manager_ready gauge\nservice_manager_ready {}\n# TYPE service_manager_uptime_seconds gauge\nservice_manager_uptime_seconds {:.3}\n# TYPE service_manager_http_requests_total counter\nservice_manager_http_requests_total {}\nservice_manager_http_errors_total {}\nservice_manager_starts_total {}\nservice_manager_stops_total {}\nservice_manager_restarts_total {}\nservice_manager_reconcile_ticks_total {}\nservice_manager_reconcile_errors_total {}\nservice_manager_tracked_services {}\nservice_manager_running_services {}\n",
            u8::from(self.is_ready()), self.started_at.elapsed().as_secs_f64(), self.requests.load(Ordering::Relaxed), self.errors.load(Ordering::Relaxed), self.starts.load(Ordering::Relaxed), self.stops.load(Ordering::Relaxed), self.restarts.load(Ordering::Relaxed), self.reconcile_ticks.load(Ordering::Relaxed), self.reconcile_errors.load(Ordering::Relaxed), tracked, running,
        )
    }
}

impl Default for Metrics {
    /// Creates the default unready metric set.
    fn default() -> Self { Self::new() }
}
