mod common;

use axum::{
    Router,
    body::{Bytes, to_bytes},
    extract::Request,
    routing::any,
};
use common::*;
use mindgrab_backend::config::{AuthMode, PostHogConfig};
use serde_json::{Value, json};
use tokio::sync::mpsc;

async fn mock() -> (
    String,
    mpsc::UnboundedReceiver<(axum::http::request::Parts, Bytes)>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let router = Router::new().fallback(any(move |request: Request| {
        let tx = tx.clone();
        async move {
            let (parts, body) = request.into_parts();
            tx.send((parts, to_bytes(body, 1024 * 1024).await.unwrap()))
                .unwrap();
            "accepted"
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, rx, task)
}

async fn login(f: &Fixture, sub: &str, consent: bool) -> Value {
    let started = f.post("startLogin", "").send().await.unwrap();
    let location = reqwest::Url::parse(started.headers()["location"].to_str().unwrap()).unwrap();
    let args: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
    let mut jar = cookies(started.headers());
    if consent {
        jar.push("mindgrab_analytics_consent=granted".into());
    }
    let response = f
        .client
        .get(format!(
            "{}/api/auth/callback?state={}&code={sub}",
            f.url, args["state"]
        ))
        .header("cookie", jar.join("; "))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["location"], format!("{}/", f.origin));
    let jar = cookies(response.headers());
    let browser = jar
        .iter()
        .find_map(|c| c.strip_prefix("mindgrab_session_loro="))
        .unwrap();
    f.rpc("getMe", browser, json!({}))
        .await
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn proxy_and_signup_consent() {
    let (host, mut events, task) = mock().await;
    let (assets, mut asset_requests, asset_task) = mock().await;
    let f = Fixture::with_posthog(
        "http://localhost:5173",
        AuthMode::WorkOs,
        Some(PostHogConfig {
            key: "test-key".into(),
            host: host.parse().unwrap(),
            assets_host: assets.parse().unwrap(),
        }),
    )
    .await;
    let response = f
        .client
        .post(format!("{}/ingest/e/?test=yes", f.url))
        .header("cookie", "secret=value")
        .header("x-forwarded-for", "203.0.113.1")
        .body("payload")
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "accepted");
    let (parts, body) = events.recv().await.unwrap();
    assert_eq!(parts.uri.to_string(), "/e/?test=yes");
    assert_eq!(body, "payload");
    assert!(!parts.headers.contains_key("cookie"));
    assert_eq!(parts.headers["x-forwarded-for"], "127.0.0.1");
    f.client
        .get(format!("{}/ingest/static/test.js", f.url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        asset_requests.recv().await.unwrap().0.uri.path(),
        "/static/test.js"
    );
    let user = login(&f, "alice", true).await;
    let (parts, body) = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parts.uri.path(), "/i/v0/e/");
    let event: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(event["event"], "signed_up");
    assert_eq!(
        event["distinct_id"],
        user["id"].as_i64().unwrap().to_string()
    );
    login(&f, "alice", true).await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), events.recv())
            .await
            .is_err()
    );
    let user = login(&f, "bob", false).await;
    let (_, body) = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(event["event"], "signed_up");
    assert_ne!(event["distinct_id"], user["id"].to_string());
    uuid::Uuid::parse_str(event["distinct_id"].as_str().unwrap()).unwrap();
    assert_eq!(event["properties"]["$process_person_profile"], false);
    f.close().await;
    task.abort();
    asset_task.abort();
}
