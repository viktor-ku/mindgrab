//! A stateless phpMyAdmin login page. Every attempt fails, and nothing submitted
//! is logged, stored, traced, sent to analytics or forwarded.
use axum::{
    Form, Router,
    body::Body,
    extract::{DefaultBodyLimit, FromRequest, Request},
    http::{HeaderName, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use rand::Rng;
use serde::Deserialize;
use std::time::Duration;

const TEMPLATE: &str = include_str!("phpmyadmin.html");
const MAX_FORM_BYTES: usize = 8 * 1024;
const MAX_DISCARDED_BYTES: usize = 64 * 1024 * 1024;
const MAX_USERNAME_CHARS: usize = 32;
const MIN_THINKING_MS: u64 = 100;
const MAX_THINKING_MS: u64 = 10_000;
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const X_ROBOTS_TAG: HeaderName = HeaderName::from_static("x-robots-tag");

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
    Router::new()
        .route("/phpmyadmin", get(directory_index))
        .route("/phpmyadmin/", get(directory_index))
        .route(
            "/phpmyadmin/index.php",
            get(login_form)
                .post(log_in)
                .layer(DefaultBodyLimit::max(MAX_FORM_BYTES)),
        )
}

async fn directory_index() -> impl IntoResponse {
    (
        StatusCode::FOUND,
        [(header::LOCATION, "/phpmyadmin/index.php")],
    )
}

async fn login_form() -> Response {
    page(None)
}

async fn log_in(request: Request) -> Response {
    let Login {
        pma_username: username,
        pma_password: password,
    } = submitted(request).await;
    let used_password = !password.is_empty();
    drop(password);
    // A separate statement: ThreadRng is not Send and must not live across the await.
    let delay = thinking_time(&mut rand::thread_rng());
    tokio::time::sleep(delay).await;
    page(Some((&username, used_password)))
}

/// Any unusable body counts as empty fields. `Form` decodes lossily, so invalid
/// UTF-8 is caught in the raw body, before any field exists to look at.
async fn submitted(request: Request) -> Login {
    let (parts, body) = request.into_parts();
    let form = read_form(body).await;
    if !is_utf8(&form) {
        return Login::default();
    }
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

/// Whether a urlencoded body decodes to UTF-8, whichever way its bytes were sent.
fn is_utf8(body: &[u8]) -> bool {
    let hex = |byte: u8| char::from(byte).to_digit(16);
    let mut decoded = Vec::with_capacity(body.len());
    let mut rest = body;
    while let [byte, tail @ ..] = rest {
        rest = tail;
        if let (b'%', [high, low, after @ ..]) = (*byte, tail)
            && let (Some(high), Some(low)) = (hex(*high), hex(*low))
        {
            decoded.push((high * 16 + low) as u8);
            rest = after;
        } else {
            decoded.push(*byte);
        }
    }
    std::str::from_utf8(&decoded).is_ok()
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

/// The only path from a submitted username to the page.
fn page(failed_login: Option<(&str, bool)>) -> Response {
    let (username, alert) = match failed_login {
        Some((username, used_password)) => {
            let username = escape(&truncated(username));
            let alert = access_denied(&username, used_password);
            (username, alert)
        }
        None => (String::new(), String::new()),
    };
    let session = random_hex();
    let cookie = format!("phpMyAdmin={session}; Path=/phpmyadmin/; HttpOnly; SameSite=Strict");
    (
        [
            (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (X_ROBOTS_TAG, "noindex, nofollow"),
            (header::SET_COOKIE, cookie.as_str()),
        ],
        Html(render(&username, &alert, &random_hex(), &session)),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, http::Method};
    use futures_util::stream;
    use rand::{SeedableRng, rngs::StdRng};
    use std::{
        convert::Infallible,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        time::Instant,
    };
    use tower::ServiceExt;

    const FORM: &str = "application/x-www-form-urlencoded";

    fn post(content_type: Option<&str>, body: impl Into<Body>) -> Request {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/phpmyadmin/index.php");
        if let Some(content_type) = content_type {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        request.body(body.into()).unwrap()
    }
    async fn send(router: Router, request: Request) -> (Response, String) {
        let response = router.oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (
            Response::from_parts(parts, Body::empty()),
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }
    async fn get() -> (Response, String) {
        let request = Request::get("/phpmyadmin/index.php")
            .body(Body::empty())
            .unwrap();
        send(routes(), request).await
    }
    async fn submit(body: &str) -> (Response, String) {
        send(routes(), post(Some(FORM), body.to_owned())).await
    }
    fn denied(username: &str, used_password: &str) -> String {
        format!("Access denied for user '{username}'@'localhost' (using password: {used_password})")
    }
    fn hidden_field<'a>(html: &'a str, name: &str) -> &'a str {
        let marker = format!(r#"name="{name}" value=""#);
        let start = html.find(&marker).unwrap() + marker.len();
        html[start..].split('"').next().unwrap()
    }
    fn is_hex(text: &str) -> bool {
        text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit())
    }
    fn assert_headers(response: &Response) {
        let headers = response.headers();
        assert_eq!(headers["content-type"], "text/html; charset=utf-8");
        assert_eq!(
            headers["content-security-policy"],
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        );
        assert_eq!(headers["x-frame-options"], "DENY");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
        let cookie = headers["set-cookie"].to_str().unwrap();
        let value = cookie
            .strip_prefix("phpMyAdmin=")
            .and_then(|cookie| {
                cookie.strip_suffix("; Path=/phpmyadmin/; HttpOnly; SameSite=Strict")
            })
            .unwrap();
        assert!(is_hex(value), "{cookie}");
    }

    #[test]
    fn thinking_time_covers_the_whole_inclusive_range_in_milliseconds() {
        let mut rng = StdRng::seed_from_u64(1045);
        let samples: Vec<Duration> = (0..1_000_000).map(|_| thinking_time(&mut rng)).collect();
        assert_eq!(samples.iter().min(), Some(&Duration::from_millis(100)));
        assert_eq!(samples.iter().max(), Some(&Duration::from_secs(10)));
        assert!(
            samples
                .iter()
                .all(|sample| sample.subsec_nanos() % 1_000_000 == 0)
        );
        let mean = samples.iter().sum::<Duration>() / samples.len() as u32;
        assert!(
            (Duration::from_millis(5_000)..Duration::from_millis(5_100)).contains(&mean),
            "{mean:?}"
        );
        let in_first_decile = samples
            .iter()
            .filter(|sample| **sample < Duration::from_millis(1_090))
            .count();
        assert!(
            (98_000..102_000).contains(&in_first_decile),
            "{in_first_decile}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_post_answers_within_the_thinking_range_of_virtual_time() {
        let mut slowest = Duration::ZERO;
        let mut fastest = Duration::MAX;
        for _ in 0..200 {
            let started = Instant::now();
            let (response, _) = submit("pma_username=root&pma_password=root").await;
            let elapsed = started.elapsed();
            assert_eq!(response.status(), 200);
            assert!(
                (Duration::from_millis(100)..=Duration::from_secs(10)).contains(&elapsed),
                "{elapsed:?}"
            );
            slowest = slowest.max(elapsed);
            fastest = fastest.min(elapsed);
        }
        assert!(slowest - fastest > Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_get_does_not_think() {
        let started = Instant::now();
        assert_eq!(get().await.0.status(), 200);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test]
    async fn the_directory_redirects_to_its_index() {
        for path in ["/phpmyadmin", "/phpmyadmin/"] {
            let request = Request::get(path).body(Body::empty()).unwrap();
            let (response, _) = send(routes(), request).await;
            assert_eq!(response.status(), StatusCode::FOUND, "{path}");
            assert_eq!(response.headers()["location"], "/phpmyadmin/index.php");
        }
    }

    #[tokio::test]
    async fn the_login_page_has_the_expected_form_and_nothing_active() {
        let (response, html) = get().await;
        assert_eq!(response.status(), 200);
        assert_headers(&response);
        for expected in [
            "<title>phpMyAdmin</title>",
            r#"<meta name="robots" content="noindex"#,
            r#"<bdo dir="ltr" lang="en">phpMyAdmin</bdo>"#,
            r#"<div class="card-header">Language</div>"#,
            r#"<option value="en" selected>English</option>"#,
            r#"<div class="card-header">Log in</div>"#,
            r#"<form method="post" action="index.php" id="login_form""#,
            r#"name="pma_username" id="input_username" value="" size="24" autocomplete="username""#,
            r#"name="pma_password" id="input_password" value="" size="24" autocomplete="current-password""#,
            r#"<input class="btn btn-primary" type="submit" id="input_go" value="Log in">"#,
            r#"name="server" value="1""#,
            r#"name="route" value="/""#,
        ] {
            assert!(html.contains(expected), "{expected}");
        }
        assert!(is_hex(hidden_field(&html, "token")));
        assert!(is_hex(hidden_field(&html, "set_session")));
        assert!(!html.contains("{{"));
        assert!(!html.contains("alert-danger\" role"));
        let lowercase = html.to_lowercase();
        for forbidden in [
            "<script",
            "javascript:",
            " onclick",
            " onload",
            "src=",
            "href=",
            "url(",
            "<link",
            "<!--",
            "/*",
            "rust",
            "axum",
            "mindgrab",
            "decoy",
            "fake",
            "joke",
        ] {
            assert!(!lowercase.contains(forbidden), "{forbidden}");
        }
    }

    #[tokio::test]
    async fn each_render_gets_a_fresh_token_and_session() {
        let (first_response, first) = get().await;
        let (second_response, second) = get().await;
        assert_ne!(
            hidden_field(&first, "token"),
            hidden_field(&second, "token")
        );
        assert_ne!(
            first_response.headers()["set-cookie"],
            second_response.headers()["set-cookie"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn every_login_fails_and_reports_whether_a_password_was_used() {
        for (body, username, used_password) in [
            ("pma_username=root&pma_password=root", "root", "YES"),
            ("pma_username=root&pma_password=", "root", "NO"),
            ("pma_username=admin", "admin", "NO"),
            ("pma_password=secret", "", "YES"),
            ("pma_username=&pma_password=", "", "NO"),
            (
                "pma_username=a+b%21&pma_password=x&set_session=y&token=z",
                "a b!",
                "YES",
            ),
        ] {
            let (response, html) = submit(body).await;
            assert_eq!(response.status(), 200, "{body}");
            assert_headers(&response);
            assert!(html.contains("alert alert-danger"), "{body}");
            assert!(html.contains("Cannot log in to the MySQL server"), "{body}");
            assert!(
                html.contains(&format!(
                    "mysqli::real_connect(): (HY000/1045): {}",
                    denied(username, used_password)
                )),
                "{html}"
            );
            assert!(
                html.contains(&format!(r#"id="input_username" value="{username}""#)),
                "{body}"
            );
            assert!(html.contains(r#"id="input_password" value="""#), "{body}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_charset_parameter_is_still_a_form() {
        let content_type = "application/x-www-form-urlencoded; charset=UTF-8";
        let request = post(Some(content_type), "pma_username=root");
        let (_, html) = send(routes(), request).await;
        assert!(html.contains(&denied("root", "NO")), "{html}");
    }

    #[tokio::test(start_paused = true)]
    async fn the_password_is_never_reflected() {
        let (response, html) = submit("pma_username=root&pma_password=canary-hunter2").await;
        assert!(!html.contains("canary-hunter2"));
        for (name, value) in response.headers() {
            assert!(
                !value.to_str().unwrap().contains("canary-hunter2"),
                "{name}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unusable_bodies_are_empty_fields_rather_than_client_errors() {
        let empty = denied("", "NO");
        let credentials = "pma_username=root&pma_password=root";
        let cases: Vec<(&str, Option<&str>, Vec<u8>)> = vec![
            ("missing body", Some(FORM), vec![]),
            ("no content type", None, credentials.into()),
            (
                "wrong content type",
                Some("application/json"),
                credentials.into(),
            ),
            (
                "near-miss content type",
                Some("text/plain"),
                credentials.into(),
            ),
            ("malformed", Some(FORM), b"%%%=&&&=%zz".to_vec()),
            (
                "repeated field",
                Some(FORM),
                b"pma_username=a&pma_username=b".to_vec(),
            ),
            (
                "raw invalid UTF-8",
                Some(FORM),
                b"pma_username=\xff\xfe&pma_password=x".to_vec(),
            ),
            (
                "escaped invalid UTF-8",
                Some(FORM),
                b"pma_username=%ff&pma_password=x".to_vec(),
            ),
            (
                "invalid password",
                Some(FORM),
                b"pma_username=root&pma_password=%c0".to_vec(),
            ),
            (
                "invalid unknown field",
                Some(FORM),
                b"pma_username=root&pma_password=x&server=%ff".to_vec(),
            ),
        ];
        for (name, content_type, body) in cases {
            let (response, html) = send(routes(), post(content_type, body)).await;
            assert_eq!(response.status(), 200, "{name}");
            assert_headers(&response);
            assert!(html.contains(&empty), "{name}: {html}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn valid_utf8_survives_the_body_check() {
        for (body, username) in [
            ("pma_username=%EF%BF%BD&pma_password=x", "\u{FFFD}"),
            ("pma_username=caf\u{e9}&pma_password=x", "caf\u{e9}"),
            ("pma_username=caf%C3%A9&pma_password=x", "caf\u{e9}"),
            ("pma_username=100%zz&pma_password=x", "100%zz"),
            ("pma_username=100%&pma_password=x%", "100%"),
        ] {
            let (_, html) = submit(body).await;
            assert!(html.contains(&denied(username, "YES")), "{body}: {html}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_route_body_limit_overrides_a_larger_router_limit() {
        let router = || routes().layer(DefaultBodyLimit::max(64 * 1024 * 1024));
        let at_limit = format!(
            "pma_username=root&pma_password=x&padding={}",
            "a".repeat(MAX_FORM_BYTES - 41)
        );
        assert_eq!(at_limit.len(), MAX_FORM_BYTES);
        let (_, html) = send(router(), post(Some(FORM), at_limit)).await;
        assert!(html.contains(&denied("root", "YES")), "{html}");

        let over_limit = format!(
            "pma_username=root&pma_password=x&padding={}",
            "a".repeat(MAX_FORM_BYTES - 40)
        );
        assert_eq!(over_limit.len(), MAX_FORM_BYTES + 1);
        let (response, html) = send(router(), post(Some(FORM), over_limit)).await;
        assert_eq!(response.status(), 200);
        assert_headers(&response);
        assert!(html.contains(&denied("", "NO")), "{html}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_still_sending_an_oversized_form_can_read_the_page() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, routes::<()>()).await });
        let mut socket = TcpStream::connect(address).await.unwrap();
        let body = "a".repeat(4 * 1024 * 1024);
        let head = format!(
            "POST /phpmyadmin/index.php HTTP/1.1\r\nhost: localhost\r\ncontent-type: {FORM}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains(&denied("", "NO")), "{response}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_endless_body_is_abandoned_past_the_discard_bound() {
        const CHUNK_BYTES: usize = 1024 * 1024;
        let chunks = Arc::new(AtomicUsize::new(0));
        let counter = chunks.clone();
        let chunk = Bytes::from(vec![b'a'; CHUNK_BYTES]);
        let endless = stream::repeat_with(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            Ok::<_, Infallible>(chunk.clone())
        });
        let (response, html) = send(routes(), post(Some(FORM), Body::from_stream(endless))).await;
        assert_eq!(response.status(), 200);
        assert!(html.contains(&denied("", "NO")), "{html}");
        assert_eq!(
            chunks.load(Ordering::Relaxed),
            MAX_DISCARDED_BYTES / CHUNK_BYTES + 1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reflected_usernames_are_escaped_everywhere() {
        let (_, html) = submit("pma_username=%3Cscript%3Ea%26%22%27%3C%2Fscript%3E").await;
        let escaped = "&lt;script&gt;a&amp;&quot;&#039;&lt;/script&gt;";
        assert!(html.contains(&denied(escaped, "NO")), "{html}");
        assert!(html.contains(&format!(r#"id="input_username" value="{escaped}""#)));
        assert!(!html.to_lowercase().contains("<script"));

        let (_, html) = submit("pma_username=%22%3E%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E").await;
        assert!(!html.contains("<img"));
        assert!(html.contains(r#"value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;""#));

        let (_, html) = submit("pma_username=%27%40%27evil%27%3C").await;
        assert!(
            html.contains(&denied("&#039;@&#039;evil&#039;&lt;", "NO")),
            "{html}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn usernames_are_cut_to_32_chars_on_a_char_boundary_before_escaping() {
        let (_, html) = submit(&format!("pma_username={}", "a".repeat(33))).await;
        assert!(html.contains(&denied(&"a".repeat(32), "NO")), "{html}");
        assert!(!html.contains(&"a".repeat(33)));

        let (_, html) = submit(&format!("pma_username={}", "%C3%A9".repeat(40))).await;
        assert!(html.contains(&denied(&"é".repeat(32), "NO")), "{html}");

        let (_, html) = submit(&format!("pma_username={}", "%26".repeat(40))).await;
        assert!(html.contains(&denied(&"&amp;".repeat(32), "NO")), "{html}");
    }

    #[tokio::test(start_paused = true)]
    async fn template_placeholders_in_a_username_render_literally() {
        for placeholder in ["{{token}}", "{{session}}", "{{alert}}", "{{username}}"] {
            let (_, html) = submit(&format!("pma_username={placeholder}")).await;
            assert!(html.contains(&denied(placeholder, "NO")), "{html}");
            assert!(
                html.contains(&format!(r#"id="input_username" value="{placeholder}""#)),
                "{placeholder}"
            );
            assert_eq!(html.matches("{{").count(), 2, "{placeholder}");
            assert!(is_hex(hidden_field(&html, "token")));
            assert!(is_hex(hidden_field(&html, "set_session")));
        }
    }
}
