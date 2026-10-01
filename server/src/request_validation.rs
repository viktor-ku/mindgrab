use axum::{body::Body, extract::Request, http::header, response::Response};
use tower_http::validate_request::{ValidateRequest, ValidateRequestHeaderLayer};

// Strict equality also rejects null, malformed origins, sibling domains and
// wrong ports. SameSite cookies and CORS do not replace this check.
#[allow(clippy::result_large_err)] // tower-http requires an unboxed Response.
pub(crate) fn same_origin(
    expected: String,
    rejection: fn() -> Response,
) -> ValidateRequestHeaderLayer<impl ValidateRequest<Body, ResponseBody = Body> + Clone> {
    ValidateRequestHeaderLayer::custom(move |request: &mut Request| {
        let mut origins = request.headers().get_all(header::ORIGIN).iter();
        if origins.next().and_then(|value| value.to_str().ok()) == Some(expected.as_str())
            && origins.next().is_none()
        {
            Ok(())
        } else {
            Err(rejection())
        }
    })
}

#[cfg(test)]
pub(crate) const REJECTED_ORIGINS: &[Option<&str>] = &[
    None,
    Some("null"),
    Some("malformed"),
    Some("https://attacker.example"),
    Some("http://sibling.localhost:5173"),
    Some("http://localhost:5174"),
    Some("https://localhost:5173"),
    Some("http://localhost:5173/"),
    Some("http://localhost:5173 https://attacker.example"),
];
