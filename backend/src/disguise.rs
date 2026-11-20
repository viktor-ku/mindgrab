//! The API's public face. Routes that pass as PHP scripts answer as PHP 8.3 does,
//! and everything else answers as the Apache in front of it. The wording and
//! headers are copied from the `php:8.3.14-apache` image.
use axum::{
    body::Body,
    extract::{MatchedPath, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

const APACHE: &str = "Apache/2.4.62 (Debian)";
const PHP: &str = "PHP/8.3.14";
/// Directories of the pretend document root. None has an index, so Apache redirects
/// to the trailing slash and then refuses to list. `/phpmyadmin/` has a route.
const DIRECTORIES: [&str; 6] = [
    "/api",
    "/api/auth",
    "/phpmyadmin",
    "/phpmyadmin/themes",
    "/phpmyadmin/themes/pmahomme",
    "/phpmyadmin/themes/pmahomme/css",
];

/// Runs outermost, so WebSocket upgrades and errors from the layers inside it are
/// all covered.
pub async fn apply(request: Request, next: Next) -> Response {
    let script = request
        .extensions()
        .get::<MatchedPath>()
        .and_then(|matched| script(matched.as_str()));
    let method = request.method().clone();
    let (host, port) = server_name(request.headers());
    let mut in_session = has_session(request.headers(), header::COOKIE);
    let mut response = if method == Method::TRACE {
        // Debian's Apache has `TraceEnable Off`: a 405 that allows nothing, on any path.
        (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "")]).into_response()
    } else {
        next.run(request).await
    };
    if let Some(script) = script.filter(|_| method != Method::TRACE) {
        if is_error(&response) && is_bare(&response) {
            response = php_error(response, &script);
        }
        in_session |= has_session(response.headers(), header::SET_COOKIE);
        let headers = response.headers_mut();
        headers.insert("x-powered-by", HeaderValue::from_static(PHP));
        // What `session_start()` sends, and the reason PHP sites are recognised by
        // a date in 1981. PHP sends them only along with a session cookie, and
        // phpMyAdmin sends its own, so a response that has `expires` keeps it.
        if in_session && !headers.contains_key(header::EXPIRES) {
            for (name, value) in [
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
                (header::EXPIRES, "Thu, 19 Nov 1981 08:52:00 GMT"),
                (header::PRAGMA, "no-cache"),
            ] {
                headers.insert(name, HeaderValue::from_static(value));
            }
        }
    } else if (is_error(&response) || response.status().is_redirection()) && is_bare(&response) {
        response = apache_page(response, &method, &host, port);
    }
    response
        .headers_mut()
        .insert(header::SERVER, HeaderValue::from_static(APACHE));
    response
}

/// Whether a `Cookie` or `Set-Cookie` header carries the session cookie. Its name
/// gains a suffix in local mode.
fn has_session(headers: &HeaderMap, name: header::HeaderName) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .any(|field| field.trim_start().starts_with(crate::auth::SESSION_COOKIE))
}

/// Every path without a route: Apache looking in its document root, as fast as
/// Apache answers. Throttling scanners is Cloudflare's job.
pub async fn missing(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let path = decoded(uri.path());
    // `mod_status` and the icon directory ship enabled on Debian and refuse outsiders.
    let is_stock =
        path == "/icons/" || path == "/server-status" || path.starts_with("/server-status/");
    if is_hidden(&path) || is_stock {
        return StatusCode::FORBIDDEN.into_response();
    }
    if method == Method::OPTIONS {
        // Apache answers this itself, for a file that exists or not.
        return [(header::ALLOW, "OPTIONS,HEAD,GET,POST")].into_response();
    }
    if let Some(directory) = DIRECTORIES.iter().find(|directory| **directory == path) {
        // Apache sees plain HTTP behind the proxy, so its redirect says `http`.
        // The path is one of ours and the query is dropped, so nothing is echoed.
        let (host, port) = server_name(&headers);
        let port = if port == 80 {
            String::new()
        } else {
            format!(":{port}")
        };
        return (
            StatusCode::MOVED_PERMANENTLY,
            [(header::LOCATION, format!("http://{host}{port}{directory}/"))],
        )
            .into_response();
    }
    if path
        .strip_suffix('/')
        .is_some_and(|directory| DIRECTORIES.contains(&directory))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

/// Apache looks a path up after decoding it, so `/%2ehtaccess` is `/.htaccess`.
fn decoded(path: &str) -> String {
    let mut bytes = Vec::with_capacity(path.len());
    let mut rest = path.as_bytes();
    while let Some((&first, tail)) = rest.split_first() {
        let digits = tail
            .get(..2)
            .and_then(|pair| std::str::from_utf8(pair).ok());
        match digits.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
            Some(byte) if first == b'%' => {
                bytes.push(byte);
                rest = &tail[2..];
            }
            _ => {
                bytes.push(first);
                rest = tail;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Debian's Apache denies `.ht*` in every directory that exists, whether or not the
/// file does. Below a directory that does not exist, the answer is the usual 404.
fn is_hidden(path: &str) -> bool {
    let mut directory = String::new();
    for segment in path.split('/').skip(1) {
        if segment.starts_with(".ht") {
            return true;
        }
        directory = format!("{directory}/{segment}");
        if !DIRECTORIES.contains(&directory.as_str()) {
            return false;
        }
    }
    false
}

/// The script a route pretends to be: `/ingest.php/{*path}` is `/ingest.php`, and a
/// directory is its `index.php`. `None` for the WebSocket routes, which Apache
/// would proxy to a daemon.
fn script(route: &str) -> Option<String> {
    if let Some(start) = route.find(".php") {
        return Some(route[..start + ".php".len()].to_owned());
    }
    route.ends_with('/').then(|| format!("{route}index.php"))
}

/// Apache signs its pages with the Host header's name and port. It answers 400 to
/// anything that is not a hostname; here such a value becomes `localhost`, so only
/// letters, digits, dots and hyphens reach a page.
fn server_name(headers: &HeaderMap) -> (String, u16) {
    let value = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (host, port) = match value.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().unwrap_or(80)),
        None => (value.as_str(), 80),
    };
    let is_hostname = !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-');
    if is_hostname {
        (host.to_owned(), port)
    } else {
        ("localhost".to_owned(), 80)
    }
}

fn is_error(response: &Response) -> bool {
    response.status().is_client_error() || response.status().is_server_error()
}

/// The webapp reads JSON errors, so those pass through. Empty and plain-text bodies
/// come from axum, and may echo the request, or from the analytics proxy.
fn is_bare(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|value| value.as_bytes().starts_with(b"text/plain"))
}

fn html(response: Response, content_type: &'static str, body: String) -> Response {
    let (mut parts, _) = response.into_parts();
    parts
        .headers
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    // Both describe the replaced body. The analytics proxy forwards upstream encodings.
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_ENCODING);
    Response::from_parts(parts, Body::from(body))
}

/// A script that refuses the method sends the status and exits. Any other failure is
/// PHP's `display_errors` output, built from the status and the route alone.
fn php_error(response: Response, script: &str) -> Response {
    let status = response.status();
    let body = if status == StatusCode::METHOD_NOT_ALLOWED {
        String::new()
    } else {
        let reason = status.canonical_reason().unwrap_or("Error");
        let file = format!("/var/www/html{script}");
        // Stable for each script, and different between them.
        let line = 11 + script.bytes().map(usize::from).sum::<usize>() % 53;
        format!(
            "<br />\n<b>Fatal error</b>:  Uncaught Exception: {} {reason} in {file}:{line}\nStack trace:\n#0 {{main}}\n  thrown in <b>{file}</b> on line <b>{line}</b><br />\n",
            status.as_u16()
        )
    };
    html(response, "text/html; charset=UTF-8", body)
}

/// Apache's own document for a status. PHP never ran, so `apply` adds no PHP headers.
fn apache_page(response: Response, method: &Method, host: &str, port: u16) -> Response {
    let status = response.status();
    let reason = status.canonical_reason().unwrap_or("Error");
    let detail = match status {
        StatusCode::MOVED_PERMANENTLY => {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            format!("<p>The document has moved <a href=\"{location}\">here</a>.</p>")
        }
        StatusCode::BAD_REQUEST => {
            "<p>Your browser sent a request that this server could not understand.<br />\n</p>"
                .to_owned()
        }
        StatusCode::FORBIDDEN => {
            "<p>You don't have permission to access this resource.</p>".to_owned()
        }
        StatusCode::NOT_FOUND => {
            "<p>The requested URL was not found on this server.</p>".to_owned()
        }
        StatusCode::METHOD_NOT_ALLOWED => {
            // hyper allows punctuation in a method name. Apache escapes it; this drops it.
            let method: String = method
                .as_str()
                .chars()
                .filter(char::is_ascii_alphabetic)
                .collect();
            format!("<p>The requested method {method} is not allowed for this URL.</p>")
        }
        StatusCode::BAD_GATEWAY => {
            "<p>The proxy server received an invalid\r\nresponse from an upstream server.<br />\r\n</p>"
                .to_owned()
        }
        StatusCode::SERVICE_UNAVAILABLE => {
            "<p>The server is temporarily unable to service your\nrequest due to maintenance downtime or capacity\nproblems. Please try again later.</p>"
                .to_owned()
        }
        // Apache's text for a 500, and for any status it has no wording for.
        _ => "<p>The server encountered an internal error or\nmisconfiguration and was unable to complete\nyour request.</p>\n<p>Please contact the server administrator at \n webmaster@localhost to inform them of the time this error occurred,\n and the actions you performed just before this error.</p>\n<p>More information about this error may be available\nin the server error log.</p>"
            .to_owned(),
    };
    let body = format!(
        "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><head>\n<title>{} {reason}</title>\n</head><body>\n<h1>{reason}</h1>\n{detail}\n<hr>\n<address>{APACHE} Server at {host} Port {port}</address>\n</body></html>\n",
        status.as_u16()
    );
    html(response, "text/html; charset=iso-8859-1", body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::post};
    use tower::ServiceExt;

    async fn ask(method: Method, path: &str) -> (Response, String) {
        let app = Router::new()
            .route("/api/getMe.php", post(|| async {}))
            .fallback(missing)
            .layer(middleware::from_fn(apply));
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "API.mindgrab.app")
            .body(Body::empty())
            .unwrap();
        let (parts, body) = app.oneshot(request).await.unwrap().into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (
            Response::from_parts(parts, Body::empty()),
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }

    // PHP's headers on a page Apache wrote, or the reverse, give the disguise away.
    #[tokio::test]
    async fn apache_answers_for_missing_files_and_php_for_its_scripts() {
        let (response, page) = ask(Method::GET, "/wp-login.php").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!response.headers().contains_key("x-powered-by"));
        assert_eq!(
            page,
            "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n<hr>\n<address>Apache/2.4.62 (Debian) Server at api.mindgrab.app Port 80</address>\n</body></html>\n"
        );

        let (response, page) = ask(Method::GET, "/api/getMe.php").await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["x-powered-by"], PHP);
        assert_eq!(response.headers()[header::ALLOW], "POST");
        assert_eq!(page, "");

        let (response, _) = ask(Method::GET, "/api/%2ehtaccess").await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let (response, page) = ask(Method::GET, "/api?next=%3Cscript%3E").await;
        assert_eq!(
            response.headers()[header::LOCATION],
            "http://api.mindgrab.app/api/"
        );
        assert!(!page.contains("script"));
    }
}
