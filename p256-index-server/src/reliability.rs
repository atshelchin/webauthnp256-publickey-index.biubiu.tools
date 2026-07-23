//! Reliability primitives ported from the retired Deno/CF-Worker service so the Rust rewrite is a
//! true operational replacement for an unattended, fund-spending queue:
//!
//! - exponential backoff schedule for transient chain failures ([`backoff_delay`]),
//! - the daily heartbeat message + funding runway estimate ([`build_heartbeat_message`]),
//! - the external-liveness watchdog decision logic ([`watchdog_decide`], driven by `bin/watchdog`).
//!
//! Everything here is pure and deterministically unit-tested; the side-effecting wiring (Telegram
//! delivery, chain reads, the periodic loops) lives in [`crate::telegram`], [`crate::worker`], and
//! `main.rs`.

use std::time::Duration;

// ── Exponential backoff ────────────────────────────────────────────────────

/// Base delay for the first retry (matches the legacy `5000 * 3^(retries-1)` schedule).
const BACKOFF_BASE: Duration = Duration::from_secs(5);
/// The legacy schedule caps a single item's back-off at 12 hours.
const BACKOFF_MAX: Duration = Duration::from_secs(12 * 60 * 60);

/// Back-off before the next attempt after `retries` consecutive transient failures (1-based):
/// `min(5s * 3^(retries-1), 12h)`. `retries == 0` is treated as the first attempt.
pub fn backoff_delay(retries: u32) -> Duration {
    let exponent = retries.saturating_sub(1).min(32);
    let scaled = BACKOFF_BASE
        .as_secs()
        .saturating_mul(3u64.saturating_pow(exponent));
    Duration::from_secs(scaled.min(BACKOFF_MAX.as_secs()))
}

// ── Daily heartbeat ────────────────────────────────────────────────────────

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Rough all-in gas per create (commit + createRecord shares). Only used for the runway estimate.
pub const EST_GAS_PER_CREATE: u64 = 300_000;

pub struct HeartbeatInput<'a> {
    pub runtime: &'a str,
    pub queue_depth: u64,
    pub dlq_count: u64,
    pub create_address: &'a str,
    pub create_balance_xdai: f64,
    pub commit_address: &'a str,
    pub commit_balance_xdai: f64,
    pub gas_price_gwei: f64,
    pub uptime: Duration,
    pub release: Option<&'a str>,
}

/// Estimated number of creates the balance can still pay for at a gas price. A non-positive gas
/// price yields `f64::INFINITY` (never a division blow-up), matching the legacy helper.
pub fn estimate_create_runway(balance_xdai: f64, gas_price_gwei: f64) -> f64 {
    if gas_price_gwei <= 0.0 {
        return f64::INFINITY;
    }
    ((balance_xdai * 1e9) / (EST_GAS_PER_CREATE as f64 * gas_price_gwei)).floor()
}

pub fn build_heartbeat_message(input: &HeartbeatInput) -> String {
    let runway = estimate_create_runway(input.create_balance_xdai, input.gas_price_gwei);
    let runway_text = if runway.is_infinite() {
        "∞".to_owned()
    } else {
        format!("~{}", runway as i64)
    };
    let up_hours = (input.uptime.as_secs() / 3_600) as i64;
    let up_text = if up_hours >= 48 {
        format!("{}d", up_hours / 24)
    } else {
        format!("{up_hours}h")
    };
    let attention = if input.dlq_count > 0 {
        format!(
            "⚠️ DLQ has {} item(s) — inspect when convenient\n",
            input.dlq_count
        )
    } else {
        String::new()
    };
    let release = input
        .release
        .map(|release| format!(", release {release}"))
        .unwrap_or_default();
    format!(
        "💓 [webauthnp256-publickey-index] [{}] [Gnosis] daily heartbeat\n\
         {attention}\
         queue: {} active, {} DLQ\n\
         create wallet {}: {:.6} xDAI ({runway_text} creates @ {:.3} gwei)\n\
         commit wallet {}: {:.6} xDAI\n\
         up {up_text}{release}",
        input.runtime,
        input.queue_depth,
        input.dlq_count,
        input.create_address,
        input.create_balance_xdai,
        input.gas_price_gwei,
        input.commit_address,
        input.commit_balance_xdai,
    )
}

// ── External-liveness watchdog (decision logic) ────────────────────────────
//
// Every alert this service can raise is emitted by the process being monitored, so if the VPS host
// dies the operator hears nothing. The watchdog runs as a *separate* process (`bin/watchdog`,
// deployed off-host) that probes the public /api/health URL and pages Telegram on sustained
// failure. This module owns only the pure decision logic; `bin/watchdog` owns probing/state/send.

pub const WATCHDOG_FAIL_THRESHOLD: u32 = 3;
pub const WATCHDOG_REPAGE: Duration = Duration::from_secs(30 * 60);
pub const WATCHDOG_SUMMARY_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
pub const WATCHDOG_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WatchdogState {
    pub consecutive_fails: u32,
    /// Epoch-ms of the last DOWN page (0 = never).
    pub last_page_at_ms: u64,
    /// True while a DOWN page has been sent and no recovery has been observed.
    pub paged: bool,
    /// Epoch-ms of the last daily summary (0 = never → first tick sends one).
    pub last_summary_at_ms: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeResult {
    /// HTTP 2xx with a parseable JSON body.
    pub ok: bool,
    /// `body.status` when parseable ("ok" | "degraded" | ...).
    pub status: Option<String>,
    pub http_status: Option<u16>,
    /// Short error description for the page text (timeout / fetch error / ...).
    pub error: Option<String>,
    /// `body.telegramConfigured`, surfaced in the daily summary.
    pub telegram_configured: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogAction {
    PageDown,
    Recover,
}

#[derive(Clone, Copy, Debug)]
pub struct WatchdogDecision {
    pub next: WatchdogState,
    pub action: Option<WatchdogAction>,
}

/// Fold a probe result into the watchdog state: page after [`WATCHDOG_FAIL_THRESHOLD`] consecutive
/// failures (re-paging every [`WATCHDOG_REPAGE`] while still down), recover on the first success
/// after a page.
pub fn watchdog_decide(state: WatchdogState, probe: &ProbeResult, now_ms: u64) -> WatchdogDecision {
    if probe.ok {
        let recovered = state.paged;
        return WatchdogDecision {
            next: WatchdogState {
                consecutive_fails: 0,
                paged: false,
                ..state
            },
            action: recovered.then_some(WatchdogAction::Recover),
        };
    }
    let consecutive_fails = state.consecutive_fails + 1;
    let should_page = consecutive_fails >= WATCHDOG_FAIL_THRESHOLD
        && (!state.paged || now_ms.saturating_sub(state.last_page_at_ms) >= repage_ms());
    if should_page {
        WatchdogDecision {
            next: WatchdogState {
                consecutive_fails,
                paged: true,
                last_page_at_ms: now_ms,
                ..state
            },
            action: Some(WatchdogAction::PageDown),
        }
    } else {
        WatchdogDecision {
            next: WatchdogState {
                consecutive_fails,
                ..state
            },
            action: None,
        }
    }
}

pub fn is_summary_due(state: &WatchdogState, now_ms: u64) -> bool {
    now_ms.saturating_sub(state.last_summary_at_ms) >= WATCHDOG_SUMMARY_INTERVAL.as_millis() as u64
}

fn repage_ms() -> u64 {
    WATCHDOG_REPAGE.as_millis() as u64
}

pub fn build_down_message(target: &str, state: &WatchdogState, probe: &ProbeResult) -> String {
    let detail = probe
        .error
        .clone()
        .or_else(|| probe.http_status.map(|status| format!("HTTP {status}")))
        .unwrap_or_else(|| "unparseable response".to_owned());
    format!(
        "🔴 [webauthnp256-publickey-index] [watchdog] VPS health probe DOWN\n\
         {} consecutive failures: {detail}\n\
         target: {target}\n\
         Creates are NOT being served. Check the VPS (systemd, host, network).",
        state.consecutive_fails,
    )
}

pub fn build_recovery_message(target: &str, down_since_ms: u64, now_ms: u64) -> String {
    let mins = if down_since_ms > 0 {
        (now_ms.saturating_sub(down_since_ms) as f64 / 60_000.0)
            .round()
            .max(1.0) as u64
    } else {
        0
    };
    let window = if mins > 0 {
        format!(" (down ~{mins} min)")
    } else {
        String::new()
    };
    format!(
        "✅ [webauthnp256-publickey-index] [watchdog] VPS health probe recovered{window}\ntarget: {target}"
    )
}

pub struct SummaryInput<'a> {
    pub target: &'a str,
    pub vps_status: &'a str,
    pub telegram_configured: Option<bool>,
}

pub fn build_summary_message(input: &SummaryInput) -> String {
    let warn = if input.telegram_configured == Some(false) {
        "\n⚠️ VPS reports telegramConfigured=false — its own alerts are NOT being delivered!"
    } else {
        ""
    };
    format!(
        "💓 [webauthnp256-publickey-index] [watchdog] daily watchdog summary\n\
         VPS ({}): {}{warn}",
        input.target, input.vps_status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_follows_the_legacy_schedule() {
        assert_eq!(backoff_delay(1), Duration::from_secs(5));
        assert_eq!(backoff_delay(2), Duration::from_secs(15));
        assert_eq!(backoff_delay(3), Duration::from_secs(45));
        assert_eq!(backoff_delay(0), Duration::from_secs(5));
        // Capped at 12h no matter how many retries.
        assert_eq!(backoff_delay(100), Duration::from_secs(12 * 60 * 60));
    }

    #[test]
    fn runway_multiplies_before_dividing() {
        assert_eq!(EST_GAS_PER_CREATE, 300_000);
        assert_eq!(estimate_create_runway(0.3, 1.0), 1000.0);
        assert_eq!(estimate_create_runway(0.3, 10.0), 100.0);
        assert!(estimate_create_runway(0.3, 0.0).is_infinite());
    }

    #[test]
    fn heartbeat_message_carries_balances_runway_queue_uptime_release() {
        let message = build_heartbeat_message(&HeartbeatInput {
            runtime: "Rust",
            queue_depth: 2,
            dlq_count: 0,
            create_address: "0xAAA",
            create_balance_xdai: 0.3,
            commit_address: "0xBBB",
            commit_balance_xdai: 0.019,
            gas_price_gwei: 1.0,
            uptime: Duration::from_secs(3 * 3_600),
            release: Some("20260710-004026"),
        });
        assert!(message.contains("daily heartbeat"));
        assert!(message.contains("2 active, 0 DLQ"));
        assert!(
            message.contains("0xAAA: 0.300000 xDAI (~1000 creates @ 1.000 gwei)"),
            "{message}"
        );
        assert!(message.contains("0xBBB: 0.019000 xDAI"));
        assert!(message.contains("up 3h"));
        assert!(message.contains("release 20260710-004026"));
        assert!(
            !message.contains('⚠'),
            "no attention line when DLQ is empty"
        );
    }

    #[test]
    fn heartbeat_flags_dlq_and_shows_multi_day_uptime() {
        let message = build_heartbeat_message(&HeartbeatInput {
            runtime: "Rust",
            queue_depth: 0,
            dlq_count: 3,
            create_address: "0xAAA",
            create_balance_xdai: 0.1,
            commit_address: "0xBBB",
            commit_balance_xdai: 0.01,
            gas_price_gwei: 1.5,
            uptime: Duration::from_secs(73 * 3_600),
            release: None,
        });
        assert!(message.contains("⚠️ DLQ has 3 item(s)"));
        assert!(message.contains("up 3d"));
        assert!(!message.contains("release"), "release omitted when unknown");
    }

    #[test]
    fn watchdog_pages_after_three_failures_then_recovers() {
        let mut state = WatchdogState::default();
        let down = ProbeResult {
            ok: false,
            error: Some("timeout".to_owned()),
            ..Default::default()
        };
        // Two failures: no page yet.
        for _ in 0..2 {
            let decision = watchdog_decide(state, &down, 1_000);
            assert_eq!(decision.action, None);
            state = decision.next;
        }
        // Third failure: page.
        let decision = watchdog_decide(state, &down, 1_000);
        assert_eq!(decision.action, Some(WatchdogAction::PageDown));
        state = decision.next;
        assert!(state.paged);
        // Still down before the re-page window: no repeat page.
        let decision = watchdog_decide(state, &down, 1_000 + 60_000);
        assert_eq!(decision.action, None);
        state = decision.next;
        // Recovery on the next success.
        let up = ProbeResult {
            ok: true,
            status: Some("ok".to_owned()),
            ..Default::default()
        };
        let decision = watchdog_decide(state, &up, 2_000_000);
        assert_eq!(decision.action, Some(WatchdogAction::Recover));
        assert_eq!(decision.next.consecutive_fails, 0);
        assert!(!decision.next.paged);
    }

    #[test]
    fn watchdog_repages_after_the_repage_window() {
        let paged = WatchdogState {
            consecutive_fails: WATCHDOG_FAIL_THRESHOLD,
            last_page_at_ms: 1_000,
            paged: true,
            last_summary_at_ms: 0,
        };
        let down = ProbeResult {
            ok: false,
            http_status: Some(502),
            ..Default::default()
        };
        let decision = watchdog_decide(paged, &down, 1_000 + repage_ms());
        assert_eq!(decision.action, Some(WatchdogAction::PageDown));
    }

    #[test]
    fn summary_is_due_on_a_fresh_state_and_after_a_day() {
        // A fresh state (last_summary_at = 0) is due on the first real tick, because `now` is a
        // real epoch timestamp far larger than the interval.
        let now = 1_700_000_000_000;
        let state = WatchdogState::default();
        assert!(is_summary_due(&state, now));
        let recent = WatchdogState {
            last_summary_at_ms: now,
            ..Default::default()
        };
        assert!(!is_summary_due(&recent, now + 60_000));
        assert!(is_summary_due(
            &recent,
            now + WATCHDOG_SUMMARY_INTERVAL.as_millis() as u64
        ));
    }
}
