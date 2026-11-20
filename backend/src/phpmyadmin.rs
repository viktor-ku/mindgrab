//! A stateless phpMyAdmin login page. Every attempt fails, and nothing submitted
//! is logged, stored, traced, sent to analytics or forwarded. Its headers and
//! cookies are copied from the `phpmyadmin:5.2` image; its files are our own.
use axum::{
    Form, Router,
    body::Body,
    extract::{DefaultBodyLimit, FromRequest, Request},
    http::{HeaderMap, HeaderName, HeaderValue, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use rand::Rng;
use serde::Deserialize;
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{sync::Semaphore, time::timeout};

const TEMPLATE: &str = include_str!("phpmyadmin.html");
const MAX_FORM_BYTES: usize = 8 * 1024;
const MAX_DISCARDED_BYTES: usize = 1024 * 1024;
const MAX_READ_TIME: Duration = Duration::from_secs(15);
const MAX_ACTIVE_LOGINS: usize = 1024;
const MAX_USERNAME_CHARS: usize = 32;
const MIN_THINKING_MS: u64 = 100;
const MAX_THINKING_MS: u64 = 10_000;
/// Stricter than phpMyAdmin's own, which allows inline scripts: no script may run on
/// the API's origin. Styles and images load from this origin only.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const X_ROBOTS_TAG: HeaderName = HeaderName::from_static("x-robots-tag");
const STYLESHEET: &str = include_str!("phpmyadmin.css");
const FAVICON: &[u8] = include_bytes!("phpmyadmin.ico");
/// When the pretend install was unpacked. Apache derives a static file's
/// `Last-Modified` and the second half of its `ETag` from this.
const INSTALLED: &str = "Tue, 07 Oct 2025 20:40:11 GMT";
const INSTALLED_MICROS: u64 = 1_759_869_611_000_000;

/// Not `Debug`, so the password cannot reach a log line. It is only checked for emptiness.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Login {
    pma_username: String,
    pma_password: String,
}

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let permits = Arc::new(Semaphore::new(MAX_ACTIVE_LOGINS));
    // Apache's `DirectoryIndex` serves the directory as its `index.php`, and
    // phpMyAdmin shows the login page whatever the method.
    let login = get(login_form)
        .post(move |request| log_in(permits.clone(), request))
        .fallback(login_form)
        .layer(DefaultBodyLimit::max(MAX_FORM_BYTES));
    Router::new()
        .route("/phpmyadmin/", login.clone())
        .route("/phpmyadmin/index.php", login.clone())
        // PHP runs the script for a path that continues past it. The decoy does
        // nothing real, so the extra spellings reach nothing.
        .route("/phpmyadmin/index.php/", login.clone())
        .route("/phpmyadmin/index.php/{*path_info}", login)
}

/// The files the login page links to, served as Apache serves a static file.
pub fn files<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/phpmyadmin/themes/pmahomme/css/theme.css",
            get(|| async { file("text/css", STYLESHEET.as_bytes()) }),
        )
        .route(
            "/phpmyadmin/favicon.ico",
            get(|| async { file("image/vnd.microsoft.icon", FAVICON) }),
        )
}

fn file(content_type: &'static str, bytes: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type.to_owned()),
            (header::LAST_MODIFIED, INSTALLED.to_owned()),
            // Apache's form: the size and the modification time, both in hex.
            (
                header::ETAG,
                format!("\"{:x}-{INSTALLED_MICROS:x}\"", bytes.len()),
            ),
            (header::ACCEPT_RANGES, "bytes".to_owned()),
        ],
        bytes,
    )
        .into_response()
}

async fn login_form(headers: HeaderMap) -> Response {
    page(&headers, None)
}

/// A permit covers reading and thinking, so a flood cannot pile up in the process
/// that also serves the API. Without one, the attempt is denied at once.
async fn log_in(permits: Arc<Semaphore>, request: Request) -> Response {
    let headers = request.headers().clone();
    let Ok(_permit) = permits.try_acquire() else {
        return page(&headers, Some(("", false)));
    };
    // Only the truncated username outlives this, so little is held while thinking.
    let (username, used_password) =
        timeout(MAX_READ_TIME, submitted(request))
            .await
            .map_or((String::new(), false), |login| {
                (
                    truncated(&login.pma_username),
                    !login.pma_password.is_empty(),
                )
            });
    // A separate statement: ThreadRng is not Send and must not live across the await.
    let delay = thinking_time(&mut rand::thread_rng());
    tokio::time::sleep(delay).await;
    page(&headers, Some((&username, used_password)))
}

/// Any unusable body counts as empty fields.
async fn submitted(request: Request) -> Login {
    let (parts, body) = request.into_parts();
    let form = read_form(body).await;
    // The route's DefaultBodyLimit still applies here and rejects an oversized form.
    Form::from_request(Request::from_parts(parts, form.into()), &())
        .await
        .map_or_else(|_| Login::default(), |Form(login)| login)
}

/// Keeps the start of the body and discards the rest. Closing the connection with
/// bytes unread resets it, and a browser still sending then never sees the page.
async fn read_form(body: Body) -> Vec<u8> {
    let mut chunks = body.into_data_stream();
    let mut form = Vec::new();
    let mut received = 0;
    while received <= MAX_DISCARDED_BYTES
        && let Some(Ok(chunk)) = chunks.next().await
    {
        received += chunk.len();
        if form.len() <= MAX_FORM_BYTES {
            form.extend_from_slice(&chunk);
        }
    }
    form
}

fn thinking_time(rng: &mut impl Rng) -> Duration {
    Duration::from_millis(rng.gen_range(MIN_THINKING_MS..=MAX_THINKING_MS))
}

fn random_hex() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn truncated(username: &str) -> String {
    username.chars().take(MAX_USERNAME_CHARS).collect()
}

/// Matches PHP's `htmlspecialchars`. Everything reflected into the page goes through this.
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#039;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// `username` must already be escaped.
fn access_denied(username: &str, used_password: bool) -> String {
    let used_password = if used_password { "YES" } else { "NO" };
    format!(
        r##"<div class="alert alert-danger" role="alert">
      <div class="alert-title"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#c00"/><path d="M5 5l6 6M11 5l-6 6" stroke="#fff" stroke-width="2"/></svg>Cannot log in to the MySQL server</div>
      mysqli::real_connect(): (HY000/1045): Access denied for user '{username}'@'localhost' (using password: {used_password})
    </div>"##
    )
}

/// Fills the template in one pass, so a placeholder inside a value stays literal.
fn render(username: &str, alert: &str, token: &str, session: &str) -> String {
    let mut html = String::with_capacity(TEMPLATE.len() + alert.len() + username.len());
    let mut rest = TEMPLATE;
    while let Some((literal, tail)) = rest.split_once("{{") {
        let (placeholder, tail) = tail.split_once("}}").unwrap();
        html.push_str(literal);
        html.push_str(match placeholder {
            "username" => username,
            "alert" => alert,
            "token" => token,
            "session" => session,
            _ => unreachable!(),
        });
        rest = tail;
    }
    html.push_str(rest);
    html
}

/// The visitor's `phpMyAdmin` cookie, if it has the shape of one of ours: 32 lowercase
/// hex characters. Nothing else is ever sent back.
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    crate::auth::cookie_value(headers, "phpMyAdmin").filter(|value| {
        value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn has_cookie(headers: &HeaderMap, name: &str) -> bool {
    crate::auth::cookie_value(headers, name).is_some()
}

/// The only path from a submitted username, already truncated, to the page.
fn page(request: &HeaderMap, failed_login: Option<(&str, bool)>) -> Response {
    let (username, alert) = match failed_login {
        Some((username, used_password)) => {
            let username = escape(username);
            let alert = access_denied(&username, used_password);
            (username, alert)
        }
        None => (String::new(), String::new()),
    };
    // phpMyAdmin repeats the session it was given, or twice a new one, and then
    // replaces it: the login page gets a fresh session on every load.
    let session = random_hex();
    let attributes = "path=/phpmyadmin/; HttpOnly; SameSite=Strict";
    let mut cookies = match session_cookie(request) {
        Some(current) => vec![format!("phpMyAdmin={current}; {attributes}")],
        None => vec![format!("phpMyAdmin={}; {attributes}", random_hex()); 2],
    };
    if !has_cookie(request, "pma_lang") {
        let expires = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(2_592_000));
        cookies.push(format!(
            "pma_lang=en; expires={expires}; Max-Age=2592000; {attributes}"
        ));
    }
    cookies.push(format!("phpMyAdmin={session}; {attributes}"));
    // phpMyAdmin writes these two dates with a numeric zone.
    let now = httpdate::fmt_http_date(SystemTime::now()).replace("GMT", "+0000");
    let mut response = (
        [
            (header::EXPIRES, now.as_str()),
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0",
            ),
            (header::LAST_MODIFIED, now.as_str()),
            (HeaderName::from_static("x-ob_mode"), "1"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::REFERRER_POLICY, "same-origin"),
            (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
            (header::X_XSS_PROTECTION, "1; mode=block"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                HeaderName::from_static("x-permitted-cross-domain-policies"),
                "none",
            ),
            (X_ROBOTS_TAG, "noindex, nofollow"),
            (header::PRAGMA, "no-cache"),
        ],
        Html(render(&username, &alert, &random_hex(), &session)),
    )
        .into_response();
    for cookie in cookies {
        response
            .headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;
    use tower::ServiceExt;

    async fn submit(body: &str) -> (Response, String) {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/phpmyadmin/index.php")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(body.to_owned()))
            .unwrap();
        let response = routes::<()>().oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (
            Response::from_parts(parts, Body::empty()),
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }
    fn denied(username: &str, used_password: &str) -> String {
        format!("Access denied for user '{username}'@'localhost' (using password: {used_password})")
    }

    // The decoy runs on the API's origin, so whatever it echoes must not
    // become script or leak the password.
    #[tokio::test(start_paused = true)]
    async fn the_password_is_never_reflected_and_usernames_are_escaped() {
        let (response, html) = submit("pma_username=root&pma_password=canary-hunter2").await;
        assert!(!html.contains("canary-hunter2"));
        for (name, value) in response.headers() {
            assert!(
                !value.to_str().unwrap().contains("canary-hunter2"),
                "{name}"
            );
        }

        let (_, html) = submit("pma_username=%3Cscript%3Ea%26%22%27%3C%2Fscript%3E").await;
        let escaped = "&lt;script&gt;a&amp;&quot;&#039;&lt;/script&gt;";
        assert!(html.contains(&denied(escaped, "NO")), "{html}");
        assert!(html.contains(&format!(r#"id="input_username" value="{escaped}""#)));
        assert!(!html.to_lowercase().contains("<script"));

        let (_, html) = submit("pma_username=%22%3E%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E").await;
        assert!(!html.contains("<img"));
        assert!(html.contains(r#"value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;""#));
    }
}
