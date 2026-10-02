use super::*;
use crate::{
    auth::tests::{fixture, provider_calls, session_for, sign_in},
    project::updates::tests::{INITIAL, new_id, register},
    response_headers::assert_private_headers,
};
use axum::{
    Router,
    body::{Bytes, to_bytes},
    http::request::Builder,
};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

async fn send(app: &Router, request: Builder, body: Body) -> Response {
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

fn request(method: &str, path: &str, cookie: &str) -> Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .extension(test_peer())
        .header(header::ORIGIN, "http://localhost:5173")
        .header(header::COOKIE, cookie)
}

async fn limited(response: Response) {
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_private_headers(response.headers());
    crate::tests::timing_duration(response.headers(), "request");
    assert!(
        response.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(error["error"]["code"], "rate_limited");
}

fn upload(cookie: &str, project: uuid::Uuid, update: uuid::Uuid) -> Builder {
    request(
        "POST",
        &format!("/api/submitProjectUpdate?projectId={project}&updateId={update}"),
        cookie,
    )
    .header(header::CONTENT_TYPE, "application/octet-stream")
    .header("x-mindgrab-schema-version", "1")
}

#[sqlx::test]
async fn quotas_share_trusted_buckets_reject_without_writes_and_recover(pool: PgPool) {
    let f = fixture(pool).await;
    let cookie = sign_in(&f).await;
    let same_account = sign_in(&f).await;
    let other = session_for(&f, "rate_limit_other").await;
    let project = register(&f.state, &cookie).await;
    let other_project = register(&f.state, &other).await;
    let limits = RateLimits::small(1, Duration::from_secs(1));
    let app = crate::router_with_limits(f.state.clone(), &limits)
        .layer(crate::cors_layer(&f.state.config).unwrap());
    let response = send(&app, request("POST", "/api/startLogin", ""), Body::empty()).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let login_cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let url = reqwest::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    for (method, path) in [
        ("POST", "/api/startLogin".to_owned()),
        (
            "GET",
            format!("/api/auth/callback?code=valid-code&state={state}"),
        ),
    ] {
        limited(
            send(
                &app,
                request(method, &path, &login_cookie)
                    .header("forwarded", "for=192.0.2.1")
                    .header("x-forwarded-for", "192.0.2.2")
                    .header("x-real-ip", "192.0.2.3"),
                Body::empty(),
            )
            .await,
        )
        .await;
    }
    assert_eq!(provider_calls(&f), 2); // Only the two earlier sign-ins.
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM auth_login_attempts")
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        1
    );
    // Cloned routers share confirmed account capacity despite cookie rotation.
    assert_eq!(
        send(
            &app,
            upload(&cookie, project, new_id()),
            Body::from(INITIAL)
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    let retry_id = new_id();
    let unread = Body::from_stream(futures_util::stream::poll_fn(
        |_| -> std::task::Poll<Option<Result<Bytes, std::io::Error>>> {
            panic!("throttled body was read")
        },
    ));
    limited(send(&app, upload(&same_account, project, retry_id), unread).await).await;
    let other_owner: i64 = sqlx::query_scalar("SELECT owner_id FROM crdt_project WHERE id = $1")
        .bind(other_project)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        send(
            &app,
            upload(&cookie, project, retry_id)
                .header("x-mindgrab-account", other_owner.to_string()),
            Body::from(INITIAL)
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        send(
            &app,
            upload(&other, other_project, new_id()),
            Body::from(INITIAL)
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT last_sequence FROM crdt_project WHERE id = $1")
            .bind(project)
            .fetch_one(&f.state.pool)
            .await
            .unwrap(),
        1
    );
    // The same exact rejected UUID/bytes obtain a durable receipt after refill.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let response = send(
        &app,
        upload(&cookie, project, retry_id),
        Body::from(INITIAL),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let receipt: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(receipt["updateId"], retry_id.to_string());
    assert_eq!(receipt["durable"], true);
    // Missing or forged sessions hit peer guards without ever choosing account
    // buckets. Both uploads and upgrade attempts follow the same boundary.
    let limits = RateLimits {
        upload_peers: config(Peer, 3, Duration::from_secs(60)),
        upgrade_peers: config(Peer, 3, Duration::from_secs(60)),
        ..RateLimits::default()
    };
    let app = crate::router_with_limits(f.state.clone(), &limits)
        .layer(crate::cors_layer(&f.state.config).unwrap());
    for (method, path) in [
        ("POST", "/api/submitProjectUpdate".to_owned()),
        ("GET", format!("/sync/v1/{project}")),
    ] {
        for cookie in ["", "mindgrab_session=forged", "mindgrab_session_v2=forged"] {
            assert_eq!(
                send(&app, request(method, &path, cookie), Body::empty())
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        limited(
            send(
                &app,
                request(method, &path, "mindgrab_session_v2=another-forgery")
                    .header("x-mindgrab-account", "999")
                    .header("x-forwarded-for", "192.0.2.1"),
                Body::empty(),
            )
            .await,
        )
        .await;
    }
    assert!(limits.uploads.limiter().is_empty());
    assert!(limits.upgrades.limiter().is_empty());
    let response = send(
        &app,
        Request::post("/api/startLogin")
            .header(header::ORIGIN, "http://localhost:5173")
            .header("x-forwarded-for", "192.0.2.1"),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}
