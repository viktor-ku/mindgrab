//! Product analytics: the first-party `/ingest.php` proxy to PostHog and
//! server-side events only the backend can observe (such as sign-ups).
//!
//! The proxy has one URL. `?r=` names the PostHog path, and only the paths the
//! webapp's SDK uses are forwarded (`upstream`). It forwards an allowlist of
//! headers, never cookies, and passes the visitor's IP so PostHog's cookieless
//! hashing and GeoIP use the real client rather than this server.
use crate::{AppState, auth::User, auth::cookie_value, config::PostHogConfig};
use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use reqwest::Url;
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};

/// Mirrors the webapp's consent choice. Without "granted" the backend never
/// links an event to a person.
pub const CONSENT_COOKIE: &str = "mindgrab_analytics_consent";
const MAX_INGEST_BYTES: usize = 5 * 1024 * 1024;
const REQUEST_HEADERS: [header::HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::CONTENT_ENCODING,
    header::ACCEPT,
    header::ACCEPT_ENCODING,
    header::USER_AGENT,
];
const RESPONSE_HEADERS: [header::HeaderName; 3] =
    [header::CONTENT_TYPE, header::CONTENT_ENCODING, header::VARY];
/// The query parameter that names the PostHog path, as in `/ingest.php?r=/e/`.
const ROUTE: &str = "r";
/// Where the SDK posts events, replay snapshots and feature flag requests.
const INGESTION_PATHS: [&str; 4] = ["/e/", "/i/v0/e/", "/s/", "/flags/"];
/// What the SDK adds to the query on those paths and on its scripts. Any other
/// parameter is dropped.
const QUERY_PARAMETERS: [&str; 4] = ["v", "t", "compression", "retry_count"];

#[derive(Clone)]
pub struct Analytics {
    config: Option<PostHogConfig>,
    client: reqwest::Client,
}
impl Analytics {
    pub fn new(config: Option<PostHogConfig>) -> Self {
        Self {
            config,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }

    /// A sign-up is linked to the account only with analytics consent;
    /// otherwise it is counted anonymously without a person profile.
    pub fn signed_up(&self, user: &User, headers: &HeaderMap) {
        let consented = cookie_value(headers, CONSENT_COOKIE).as_deref() == Some("granted");
        let (distinct_id, mut properties) = if consented {
            (user.id.to_string(), json!({}))
        } else {
            (
                uuid::Uuid::new_v4().to_string(),
                json!({"$process_person_profile": false}),
            )
        };
        properties["$lib"] = "mindgrab-backend".into();
        // This server's location says nothing about the person.
        properties["$geoip_disable"] = true.into();
        self.capture("signed_up", distinct_id, properties);
    }

    fn capture(&self, event: &'static str, distinct_id: String, properties: Value) {
        let Some(config) = self.config.clone() else {
            return;
        };
        let client = self.client.clone();
        // Analytics must never delay or fail sign-in.
        tokio::spawn(async move {
            let url = config.host.join("/i/v0/e/").unwrap();
            let body = json!({
                "api_key": config.key,
                "event": event,
                "distinct_id": distinct_id,
                "properties": properties,
            });
            let result = client
                .post(url)
                .json(&body)
                .send()
                .await
                .and_then(|response| response.error_for_status());
            if let Err(error) = result {
                tracing::warn!(%error, event, "PostHog capture failed");
            }
        });
    }

    async fn forward(&self, request: Request) -> Response {
        let Some(config) = &self.config else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(peer)| peer.ip());
        let (parts, body) = request.into_parts();
        let Some(url) = upstream(config, &parts.method, parts.uri.query()) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        // A script or config request has nothing to send.
        let limit = if parts.method == Method::POST {
            MAX_INGEST_BYTES
        } else {
            0
        };
        let Ok(body) = to_bytes(body, limit).await else {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        };
        let mut headers = HeaderMap::new();
        for name in REQUEST_HEADERS {
            if let Some(value) = parts.headers.get(&name) {
                headers.insert(name, value.clone());
            }
        }
        if let Some(ip) = peer.and_then(|ip| HeaderValue::from_str(&ip.to_string()).ok()) {
            headers.insert("x-forwarded-for", ip);
        }
        let upstream = match self
            .client
            .request(parts.method, url)
            .headers(headers)
            .body(body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, "PostHog proxy request failed");
                return StatusCode::BAD_GATEWAY.into_response();
            }
        };
        let status = upstream.status();
        let mut response_headers = HeaderMap::new();
        for name in RESPONSE_HEADERS {
            if let Some(value) = upstream.headers().get(&name) {
                response_headers.insert(name, value.clone());
            }
        }
        match upstream.bytes().await {
            Ok(bytes) => {
                let mut response = Response::new(Body::from(bytes));
                *response.status_mut() = status;
                *response.headers_mut() = response_headers;
                response
            }
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        }
    }
}

/// The PostHog URL a request to `/ingest.php` stands for, or `None` for anything
/// the webapp's SDK does not send. Only a known path with its own method goes
/// upstream: `POST` for ingestion, `GET` for the SDK's scripts and its remote
/// config.
fn upstream(config: &PostHogConfig, method: &Method, query: Option<&str>) -> Option<Url> {
    // Borrowed for its query parser. The host is not used.
    let mut request = config.host.clone();
    request.set_query(query);
    let route = request
        .query_pairs()
        .find_map(|(name, value)| (name == ROUTE).then(|| value.into_owned()))?;
    let mut url = if INGESTION_PATHS.contains(&route.as_str()) && method == Method::POST {
        config.host.clone()
    } else if is_asset(&route, &config.key) && method == Method::GET {
        config.assets_host.clone()
    } else {
        return None;
    };
    url.set_path(&route);
    url.set_query(None);
    let kept: Vec<_> = request
        .query_pairs()
        .filter(|(name, _)| QUERY_PARAMETERS.contains(&name.as_ref()))
        .collect();
    if !kept.is_empty() {
        url.query_pairs_mut().extend_pairs(kept);
    }
    Some(url)
}

/// The project's remote config, or one of the SDK's lazily loaded scripts:
/// `/static/<name>.js`, which PostHog also serves as `/static/<version>/<name>.js`.
fn is_asset(route: &str, key: &str) -> bool {
    if let Some(file) = route.strip_prefix("/static/") {
        let (version, name) = file.rsplit_once('/').unwrap_or(("0", file));
        let is_word = |word: &str| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        };
        return version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            && name.ends_with(".js")
            && name.split('.').all(is_word);
    }
    route
        .strip_prefix("/array/")
        .and_then(|rest| rest.strip_prefix(key))
        .is_some_and(|file| file == "/config.js" || file == "/config")
}

pub async fn ingest(axum::extract::State(app): AppState, request: Request) -> Response {
    app.analytics.forward(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PostHogConfig {
        PostHogConfig {
            key: "phc_ours".into(),
            host: "https://eu.i.posthog.com".parse().unwrap(),
            assets_host: "https://eu-assets.i.posthog.com".parse().unwrap(),
        }
    }

    fn target(method: Method, query: &str) -> Option<String> {
        upstream(&config(), &method, Some(query)).map(String::from)
    }

    #[test]
    fn only_the_sdk_paths_reach_posthog() {
        for (method, query, expected) in [
            (Method::POST, "r=%2Fe%2F", "https://eu.i.posthog.com/e/"),
            (
                Method::POST,
                "r=/i/v0/e/",
                "https://eu.i.posthog.com/i/v0/e/",
            ),
            (Method::POST, "r=/s/", "https://eu.i.posthog.com/s/"),
            (
                Method::POST,
                "v=2&r=%2Fflags%2F",
                "https://eu.i.posthog.com/flags/?v=2",
            ),
            (
                Method::GET,
                "r=/static/1.444.0/posthog-recorder.js",
                "https://eu-assets.i.posthog.com/static/1.444.0/posthog-recorder.js",
            ),
            (
                Method::GET,
                "v=1.444.0&r=/static/web-vitals-with-attribution.js",
                "https://eu-assets.i.posthog.com/static/web-vitals-with-attribution.js?v=1.444.0",
            ),
            (
                Method::GET,
                "r=/array/phc_ours/config.js",
                "https://eu-assets.i.posthog.com/array/phc_ours/config.js",
            ),
            (
                Method::GET,
                "r=/array/phc_ours/config",
                "https://eu-assets.i.posthog.com/array/phc_ours/config",
            ),
            // A parameter the SDK never sends does not travel.
            (
                Method::POST,
                "r=/e/&personal_api_key=phx_theirs&compression=base64&retry_count=2",
                "https://eu.i.posthog.com/e/?compression=base64&retry_count=2",
            ),
        ] {
            assert_eq!(target(method, query).as_deref(), Some(expected), "{query}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for (method, query) in [
            (Method::GET, ""),
            (Method::GET, "r="),
            (Method::POST, "path=/e/"),
            // PostHog's private API, with either method.
            (Method::GET, "r=/api/projects/@current"),
            (Method::POST, "r=/api/projects/@current"),
            (Method::POST, "r=/batch/"),
            // A known path with the other method.
            (Method::GET, "r=/e/"),
            (Method::POST, "r=/static/1.444.0/posthog-recorder.js"),
            // Near misses of a known path.
            (Method::POST, "r=/e"),
            (Method::POST, "r=e/"),
            (Method::POST, "r=/e/../api/projects/"),
            (Method::POST, "r=//evil.example/e/"),
            (Method::POST, "r=/E/"),
            // Only scripts, only from `/static/`, and only this project's config.
            (Method::GET, "r=/static/"),
            (Method::GET, "r=/static/.js"),
            (Method::GET, "r=/static/toolbar.css"),
            (Method::GET, "r=/static/index.html"),
            (Method::GET, "r=/static/../array/phc_theirs/config.js"),
            (Method::GET, "r=/static/%2e%2e/api/x.js"),
            (Method::GET, "r=/static/a/b/c.js"),
            (Method::GET, "r=/static/1..0/a.js"),
            (Method::GET, "r=/static/a.js%3Fx"),
            (Method::GET, "r=/static/a.js%23x"),
            (Method::GET, "r=/static/A.js"),
            (Method::GET, "r=/array/phc_theirs/config.js"),
            (Method::GET, "r=/array/phc_ours/config.json"),
            (Method::GET, "r=/array/phc_oursx/config"),
            (Method::GET, "r=/array/phc_ours/../../api/x"),
        ] {
            assert_eq!(target(method.clone(), query), None, "{method} {query}");
        }
    }
}
