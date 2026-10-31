//! Product analytics: the first-party `/ingest` proxy to PostHog and
//! server-side events only the backend can observe (such as sign-ups).
//!
//! The proxy forwards an allowlist of headers, never cookies, and passes the
//! visitor's IP so PostHog's cookieless hashing and GeoIP use the real client
//! rather than this server.
use crate::{AppState, auth::User, auth::cookie_value, config::PostHogConfig};
use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
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
        let path = parts.uri.path().strip_prefix("/ingest").unwrap_or("/");
        let mut url = if path.starts_with("/static/") || path.starts_with("/array/") {
            config.assets_host.clone()
        } else {
            config.host.clone()
        };
        url.set_path(path);
        url.set_query(parts.uri.query());
        let Ok(body) = to_bytes(body, MAX_INGEST_BYTES).await else {
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

pub async fn ingest(axum::extract::State(app): AppState, request: Request) -> Response {
    app.analytics.forward(request).await
}
