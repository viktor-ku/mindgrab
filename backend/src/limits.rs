use crate::{Backend, error::ApiError};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

type Buckets = HashMap<(IpAddr, &'static str), (Instant, u32)>;

#[derive(Default)]
pub struct RateLimits(Mutex<Buckets>);
impl RateLimits {
    fn take(&self, ip: IpAddr, group: &'static str, limit: u32) -> bool {
        let mut records = self.0.lock().unwrap();
        records.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(60));
        if records.len() >= 10000 && !records.contains_key(&(ip, group)) {
            return false;
        }
        let (_, count) = records.entry((ip, group)).or_insert((Instant::now(), 0));
        *count += 1;
        *count <= limit
    }
}
pub async fn guard(
    State(app): State<std::sync::Arc<Backend>>,
    request: Request,
    next: Next,
) -> Response {
    if let Some(ConnectInfo(peer)) = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
    {
        let path = request.uri().path();
        let (group, limit) = if matches!(path, "/api/startLogin" | "/api/auth/callback") {
            ("login", 30)
        } else if path == "/api/mergeProject" {
            ("upload", 240)
        } else if path.starts_with("/sync/") {
            ("socket", 60)
        } else {
            ("api", 1200)
        };
        if !app.limits.take(peer.ip(), group, limit) {
            let mut response =
                ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited").into_response();
            response
                .headers_mut()
                .insert("retry-after", "60".parse().unwrap());
            return response;
        }
    }
    next.run(request).await
}
