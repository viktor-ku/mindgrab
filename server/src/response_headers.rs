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
        http::StatusCode,
        middleware::{self, Next},
        response::{IntoResponse, Response},
        routing::post,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn conflicting_values_are_replaced_without_changing_body_or_other_headers() {
        let app = Router::new()
            .route(
                "/",
                post(|| async {
                    let mut response = "private body".into_response();
                    for value in ["public", "max-age=3600"] {
                        response
                            .headers_mut()
                            .append(header::CACHE_CONTROL, HeaderValue::from_static(value));
                    }
                    for value in ["unsafe-url", "origin"] {
                        response
                            .headers_mut()
                            .append(header::REFERRER_POLICY, HeaderValue::from_static(value));
                    }
                    for value in [
                        "session=one; HttpOnly; SameSite=Lax; Secure; Path=/",
                        "login=; Max-Age=0; Path=/",
                    ] {
                        response
                            .headers_mut()
                            .append(header::SET_COOKIE, HeaderValue::from_static(value));
                    }
                    response
                        .headers_mut()
                        .insert("server-timing", HeaderValue::from_static("db;dur=1"));
                    response
                }),
            )
            .layer(private_headers());
        let response = app
            .oneshot(Request::post("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_private_headers(response.headers());
        assert_eq!(response.headers()["server-timing"], "db;dur=1");
        let cookies: Vec<_> = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(
            cookies,
            [
                "session=one; HttpOnly; SameSite=Lax; Secure; Path=/",
                "login=; Max-Age=0; Path=/"
            ]
        );
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
            let response = app
                .oneshot(Request::post("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
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
        let response: Response = app
            .oneshot(Request::post("/").body(Body::from("too large")).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_private_headers(response.headers());
    }
}
