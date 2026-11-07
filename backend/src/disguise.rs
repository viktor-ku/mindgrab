//! The API's public face: Apache's response headers and PHP's error output.
use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, header},
    middleware::Next,
    response::Response,
};

/// Runs outermost, so CORS preflights, WebSocket upgrades and errors from the
/// layers inside it are all covered.
pub async fn apply(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if is_framework_error(&response) {
        response = php_error(response);
    }
    let headers = response.headers_mut();
    headers.insert(
        header::SERVER,
        HeaderValue::from_static("Apache/2.4.62 (Debian)"),
    );
    for name in ["x-powered-by", "x-powered-by.php"] {
        headers.insert(name, HeaderValue::from_static("PHP/8.3.14"));
    }
    response
}

/// The webapp reads JSON errors, so those pass through. Anything else that failed
/// came from axum, as an empty or plain-text body that may echo the request.
fn is_framework_error(response: &Response) -> bool {
    let status = response.status();
    (status.is_client_error() || status.is_server_error())
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_none_or(|value| value.as_bytes().starts_with(b"text/plain"))
}

/// PHP's `display_errors` output. Built from the status alone, so it reflects nothing.
fn php_error(response: Response) -> Response {
    let (mut parts, _) = response.into_parts();
    let status = parts.status;
    let reason = status.canonical_reason().unwrap_or("Error");
    let body = format!(
        "<br />\n<b>Fatal error</b>:  Uncaught Exception: {} {reason} in /var/www/html/index.php:42\nStack trace:\n#0 {{main}}\n  thrown in <b>/var/www/html/index.php</b> on line <b>42</b><br />\n",
        status.as_u16()
    );
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=UTF-8"),
    );
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(body))
}
