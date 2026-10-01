use axum::http::{HeaderValue, header};
use tower_http::set_header::SetResponseHeaderLayer;

/// Apply after any rejecting layers so their responses also receive the headers.
/// Keep this at private router boundaries, leaving public route caching alone.
pub(crate) fn private_headers() -> (
    SetResponseHeaderLayer<HeaderValue>,
    SetResponseHeaderLayer<HeaderValue>,
) {
    (
        SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ),
        SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ),
    )
}

#[cfg(test)]
pub(crate) fn assert_private_headers(headers: &axum::http::HeaderMap) {
    for (name, expected) in [
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
    ] {
        let values: Vec<_> = headers.get_all(name).iter().collect();
        assert_eq!(values, [expected]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::{DefaultBodyLimit, Request},
        http::{HeaderMap, HeaderName, StatusCode},
        middleware::{self, Next},
        response::{IntoResponse, Response},
        routing::post,
    };
    use tower::ServiceExt;

    async fn send(app: Router, body: Body) -> Response {
        app.oneshot(Request::post("/").body(body).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn conflicting_values_are_replaced_without_changing_body_or_other_headers() {
        let cookies = [
            "session=one; HttpOnly; SameSite=Lax; Secure; Path=/",
            "login=; Max-Age=0; Path=/",
        ];
        let mut headers = HeaderMap::new();
        for (name, value) in [
            (header::CACHE_CONTROL, "public"),
            (header::CACHE_CONTROL, "max-age=3600"),
            (header::REFERRER_POLICY, "unsafe-url"),
            (header::REFERRER_POLICY, "origin"),
            (header::SET_COOKIE, cookies[0]),
            (header::SET_COOKIE, cookies[1]),
            (HeaderName::from_static("server-timing"), "db;dur=1"),
        ] {
            headers.append(name, HeaderValue::from_static(value));
        }
        let app = Router::new()
            .route("/", post(move || async move { (headers, "private body") }))
            .layer(private_headers());
        let response = send(app, Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_private_headers(response.headers());
        assert_eq!(response.headers()["server-timing"], "db;dur=1");
        let actual_cookies: Vec<_> = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(actual_cookies, cookies);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "private body"
        );
    }

    #[tokio::test]
    async fn headers_cover_short_circuiting_layers() {
        async fn must_not_run() -> Response {
            panic!("rejecting layer must bypass handler")
        }
        // Model future rate-limit, validation, session and service-failure layers.
        for status in [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let app = Router::new()
                .route("/", post(must_not_run))
                .layer(middleware::from_fn(move |_: Request, _: Next| async move {
                    (status, "rejected").into_response()
                }))
                .layer(private_headers());
            let response = send(app, Body::empty()).await;
            assert_eq!(response.status(), status);
            assert_private_headers(response.headers());
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                "rejected"
            );
        }
    }

    #[tokio::test]
    async fn headers_cover_body_limit_rejections() {
        let app = Router::new()
            .route("/", post(|_: String| async { "ok" }))
            .layer(DefaultBodyLimit::max(1))
            .layer(private_headers());
        let response = send(app, Body::from("too large")).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_private_headers(response.headers());
    }
}
