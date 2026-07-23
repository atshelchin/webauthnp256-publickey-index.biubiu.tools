//! External-liveness watchdog — a **separate** process from the VPS service it monitors.
//!
//! Every alert the main service can raise is emitted by the process being monitored, so if the VPS
//! host dies, loses network, or systemd wedges, the operator hears nothing. This binary is that
//! independent probe layer: deploy it off-host (a different machine / a small cron host) with the
//! Telegram secrets, point it at the public `/api/health` URL, and it pages when the target is
//! sustainedly down and confirms life with a daily summary.
//!
//! Config via environment:
//! - `WATCHDOG_TARGET_URL` — health endpoint to probe (defaults to the production URL).
//! - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — alert channel (required to page).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde_json::Value;

use p256_index_server::{
    reliability::{
        ProbeResult, SummaryInput, WATCHDOG_PROBE_TIMEOUT, WatchdogAction, WatchdogState,
        build_down_message, build_recovery_message, build_summary_message, is_summary_due,
        watchdog_decide,
    },
    telegram::Telegram,
};

const DEFAULT_TARGET: &str = "https://webauthnp256-publickey-index.biubiu.tools/api/health";
const PROBE_INTERVAL: Duration = Duration::from_secs(60);

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "p256_index_server=info".into()),
        )
        .init();

    let target = std::env::var("WATCHDOG_TARGET_URL").unwrap_or_else(|_| DEFAULT_TARGET.to_owned());
    let telegram = Telegram::new(
        std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default(),
        std::env::var("TELEGRAM_CHAT_ID").unwrap_or_default(),
    );
    if telegram.is_none() {
        tracing::warn!("TELEGRAM_* unset — the watchdog can observe but cannot page anyone");
    }
    let http = Client::builder()
        .timeout(WATCHDOG_PROBE_TIMEOUT)
        .build()
        .expect("http client");

    tracing::info!(target = %target, "external watchdog started");
    let mut state = WatchdogState::default();

    loop {
        let now = now_ms();
        let probe = probe(&http, &target).await;
        let down_since = state.last_page_at_ms;
        let decision = watchdog_decide(state, &probe, now);
        state = decision.next;

        match decision.action {
            Some(WatchdogAction::PageDown) => {
                tracing::warn!(target = %target, "watchdog paging: target DOWN");
                send(&telegram, &build_down_message(&target, &state, &probe)).await;
            }
            Some(WatchdogAction::Recover) => {
                tracing::info!(target = %target, "watchdog: target recovered");
                send(&telegram, &build_recovery_message(&target, down_since, now)).await;
            }
            None => {}
        }

        if is_summary_due(&state, now) {
            state.last_summary_at_ms = now;
            let vps_status = if probe.ok {
                probe.status.clone().unwrap_or_else(|| "ok".to_owned())
            } else {
                "DOWN".to_owned()
            };
            send(
                &telegram,
                &build_summary_message(&SummaryInput {
                    target: &target,
                    vps_status: &vps_status,
                    telegram_configured: probe.telegram_configured,
                }),
            )
            .await;
        }

        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

async fn probe(http: &Client, target: &str) -> ProbeResult {
    match http.get(target).send().await {
        Ok(response) => {
            let status = response.status();
            if !status.is_success() {
                return ProbeResult {
                    ok: false,
                    http_status: Some(status.as_u16()),
                    ..Default::default()
                };
            }
            match response.json::<Value>().await {
                Ok(body) => ProbeResult {
                    ok: true,
                    status: body
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    telegram_configured: body.get("telegramConfigured").and_then(Value::as_bool),
                    ..Default::default()
                },
                Err(_) => ProbeResult {
                    ok: false,
                    error: Some("unparseable response".to_owned()),
                    ..Default::default()
                },
            }
        }
        Err(error) => {
            let detail = if error.is_timeout() {
                format!("probe timeout ({}s)", WATCHDOG_PROBE_TIMEOUT.as_secs())
            } else {
                "fetch error".to_owned()
            };
            ProbeResult {
                ok: false,
                error: Some(detail),
                ..Default::default()
            }
        }
    }
}

async fn send(telegram: &Option<Telegram>, message: &str) {
    if let Some(telegram) = telegram {
        telegram.send(message).await;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
