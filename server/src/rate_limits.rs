//! Request quotas are per router/server, shared by its clones. See
//! `server/docs/rate-limits.md` for quotas, ordering and deployment policy.
use std::time::Duration;

use axum::{
    Json,
    body::Body,
    http::{Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use governor::middleware::NoOpMiddleware;
use tower_governor::{
    GovernorError, GovernorLayer,
    governor::{GovernorConfig, GovernorConfigBuilder},
    key_extractor::KeyExtractor,
};

use crate::auth::User;

pub(crate) use tower_governor::key_extractor::PeerIpKeyExtractor as Peer;

#[derive(Clone, Copy)]
pub(crate) struct Account;

impl KeyExtractor for Account {
    type Key = i64;

    fn extract<T>(&self, request: &Request<T>) -> Result<i64, GovernorError> {
        // project::protect inserts User only after WorkOS/session validation.
        request
            .extensions()
            .get::<User>()
            .map(|user| user.id)
            .ok_or(GovernorError::UnableToExtractKey)
    }
}

type Config<K> = std::sync::Arc<GovernorConfig<K, NoOpMiddleware>>;
pub(crate) type Layer<K> = GovernorLayer<K, NoOpMiddleware, Body>;

pub(crate) struct RateLimits {
    pub(crate) login: Config<Peer>,
    pub(crate) upload_peers: Config<Peer>,
    pub(crate) uploads: Config<Account>,
    pub(crate) upgrade_peers: Config<Peer>,
    pub(crate) upgrades: Config<Account>,
}

fn config<K: KeyExtractor>(key: K, burst: u32, period: Duration) -> Config<K> {
    GovernorConfigBuilder::default()
        .key_extractor(key)
        .burst_size(burst)
        .period(period)
        .finish()
        .expect("nonzero request quota")
        .into()
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            // Start + callback share a bucket; five complete logins per burst.
            login: config(Peer, 10, Duration::from_secs(6)),
            upload_peers: config(Peer, 600, Duration::from_millis(20)),
            uploads: config(Account, 120, Duration::from_millis(100)),
            upgrade_peers: config(Peer, 120, Duration::from_millis(200)),
            upgrades: config(Account, 20, Duration::from_secs(3)),
        }
    }
}

impl RateLimits {
    pub(crate) fn layer<K: KeyExtractor>(config: &Config<K>) -> Layer<K> {
        GovernorLayer::new(config.clone()).error_handler(rejection)
    }

    pub(crate) fn start_cleanup(self) {
        // Only the production server starts this task. Test routers own/drop
        // their isolated configurations without spawning background work.
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                for config in [&self.login, &self.upload_peers, &self.upgrade_peers] {
                    config.limiter().retain_recent();
                    config.limiter().shrink_to_fit();
                }
                for config in [&self.uploads, &self.upgrades] {
                    config.limiter().retain_recent();
                    config.limiter().shrink_to_fit();
                }
            }
        });
    }

    #[cfg(test)]
    pub(crate) fn small(burst: u32, period: Duration) -> Self {
        Self {
            login: config(Peer, burst, period),
            uploads: config(Account, burst, period),
            upgrades: config(Account, burst, period),
            ..Self::default()
        }
    }
}

fn rejection(error: GovernorError) -> Response {
    match error {
        GovernorError::TooManyRequests { wait_time, .. } => {
            // tower_governor rounds down to seconds. Round up conservatively
            // so fractional quotas never tell clients to spin with a zero wait.
            let retry_after = wait_time.saturating_add(1).to_string();
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, retry_after)],
                Json(serde_json::json!({"error": {"code": "rate_limited", "message": "Too many requests. Retry after the indicated delay."}})),
            ).into_response()
        }
        // Missing trusted metadata indicates incorrect middleware/server wiring.
        // Fail closed instead of falling back to caller-controlled headers.
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": {"code": "unavailable", "message": "Request limiting is temporarily unavailable."}})),
        ).into_response(),
    }
}

#[cfg(test)]
pub(crate) fn test_peer() -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo("127.0.0.1:12345".parse().unwrap())
}

#[cfg(test)]
mod tests;
