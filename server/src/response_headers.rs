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
