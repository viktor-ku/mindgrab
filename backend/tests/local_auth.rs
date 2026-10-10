mod common;

use axum::http::HeaderMap;
use common::*;
use mindgrab_backend::{
    auth::{Auth, SESSION_COOKIE},
    config::AuthMode,
};
use serde_json::{Value, json};
use uuid::Uuid;

async fn login(f: &Fixture, previous: &str) -> String {
    let started = f.post("startLogin", previous).send().await.unwrap();
    assert_eq!(started.status(), 303);
    let location = reqwest::Url::parse(started.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(location.origin().ascii_serialization(), f.origin);
    assert_eq!(location.path(), "/api/auth/callback");
    let mut jar = cookies(started.headers());
    if !previous.is_empty() {
        jar.push(format!(
            "{}={previous}",
            f.backend.config.cookie_name(SESSION_COOKIE)
        ));
    }
    assert!(
        started.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    let callback = format!("{}/api/auth/callback?{}", f.url, location.query().unwrap());
    let invalid = f.client.get(&callback).send().await.unwrap();
    assert!(
        invalid.headers()["location"]
            .to_str()
            .unwrap()
            .contains("auth_error")
    );
    let response = f
        .client
        .get(&callback)
        .header("cookie", jar.join("; "))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["location"], format!("{}/", f.origin));
    let replay = f
        .client
        .get(&callback)
        .header("cookie", jar.join("; "))
        .send()
        .await
        .unwrap();
    assert!(
        replay.headers()["location"]
            .to_str()
            .unwrap()
            .contains("auth_error")
    );
    let name = f.backend.config.cookie_name(SESSION_COOKIE);
    cookies(response.headers())
        .iter()
        .find_map(|cookie| cookie.strip_prefix(&format!("{name}=")).map(str::to_owned))
        .unwrap()
}

#[tokio::test]
async fn local_login_protects_projects_and_logout_revokes_the_session_without_a_provider() {
    let f = Fixture::with_auth_mode("http://localhost:24000", AuthMode::Local).await;
    assert_eq!(f.rpc("getMe", "", json!({})).await.status(), 401);
    assert_eq!(f.rpc("listProjects", "", json!({})).await.status(), 401);
    assert_eq!(
        f.client
            .post(format!("{}/api/startLogin", f.url))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.post("logout", "")
            .header("origin", "https://foreign.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    let browser = login(&f, "").await;
    let user: Value = f
        .rpc("getMe", &browser, json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(user["external_id"], "local_boba_tee");
    assert_eq!(user["name"], "Boba Tee");
    assert_eq!(user["email"], "boba.tee@mindgrab.test");
    assert_eq!(
        f.post("getMe", &browser)
            .header("x-mindgrab-account", "999")
            .send()
            .await
            .unwrap()
            .status(),
        409
    );

    let id = Uuid::new_v4();
    assert_eq!(
        f.rpc(
            "createProject",
            &browser,
            json!({"projectId": id, "schemaVersion": 1})
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        f.rpc("getProjectSnapshot", &browser, json!({"projectId": id}))
            .await
            .status(),
        200
    );

    // Browsers send every localhost cookie to every port; another worktree must ignore it,
    // even if the databases were accidentally shared.
    let mut other_config = f.backend.config.clone();
    other_config.app_url = "http://localhost:24003/".into();
    let other = Auth::new(f.backend.pool.clone(), other_config);
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("{}={browser}", f.backend.config.cookie_name(SESSION_COOKIE))
            .parse()
            .unwrap(),
    );
    assert_eq!(other.identify(&headers).await.unwrap_err().status, 401);

    let replacement = login(&f, &browser).await;
    assert_ne!(browser, replacement);
    assert_eq!(f.rpc("getMe", &browser, json!({})).await.status(), 401);
    let logout = f.post("logout", &replacement).send().await.unwrap();
    assert_eq!(logout.headers()["location"], format!("{}/", f.origin));
    assert!(cookies(logout.headers()).contains(&format!(
        "{}=",
        f.backend.config.cookie_name(SESSION_COOKIE)
    )));
    assert_eq!(f.rpc("getMe", &replacement, json!({})).await.status(), 401);
    assert_eq!(
        f.rpc(
            "createProject",
            &replacement,
            json!({"projectId": Uuid::new_v4(), "schemaVersion": 1})
        )
        .await
        .status(),
        401
    );
    let signed_in_again = login(&f, "").await;
    let again: Value = f
        .rpc("getMe", &signed_in_again, json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(again["id"], user["id"]);
    f.close().await;
}

#[tokio::test]
async fn local_sessions_expire_and_are_incompatible_with_workos_sessions() {
    let f = Fixture::with_auth_mode("http://localhost:24006", AuthMode::Local).await;
    let browser = login(&f, "").await;
    sqlx::query("UPDATE mindgrab_loro.sessions SET expires_at=now() - interval '1 second'")
        .execute(&f.backend.pool)
        .await
        .unwrap();
    assert_eq!(f.rpc("getMe", &browser, json!({})).await.status(), 401);

    let real = f.credential("alice").await;
    assert_eq!(f.rpc("getMe", &real, json!({})).await.status(), 401);
    let browser = login(&f, "").await;
    let mut config = f.backend.config.clone();
    config.auth_mode = AuthMode::WorkOs;
    let workos = Auth::new(f.backend.pool.clone(), config);
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("{SESSION_COOKIE}={browser}").parse().unwrap(),
    );
    assert_eq!(workos.identify(&headers).await.unwrap_err().status, 401);
    f.close().await;
}

#[tokio::test]
async fn local_callbacks_reject_wrong_code_expiry_and_duplicate_parameters() {
    let f = Fixture::with_auth_mode("http://localhost:24009", AuthMode::Local).await;
    for failure in ["wrong_code", "expired", "duplicate_code"] {
        let started = f.post("startLogin", "").send().await.unwrap();
        let location =
            reqwest::Url::parse(started.headers()["location"].to_str().unwrap()).unwrap();
        let mut args: Vec<(String, String)> = location.query_pairs().into_owned().collect();
        match failure {
            "wrong_code" => {
                args.iter_mut().find(|(key, _)| key == "code").unwrap().1 = "wrong".into()
            }
            "expired" => {
                sqlx::query("UPDATE mindgrab_loro.login_attempts SET expires_at=now() - interval '1 second'").execute(&f.backend.pool).await.unwrap();
            }
            "duplicate_code" => args.push(("code".into(), "duplicate".into())),
            _ => unreachable!(),
        }
        let mut callback = reqwest::Url::parse(&format!("{}/api/auth/callback", f.url)).unwrap();
        callback.query_pairs_mut().extend_pairs(args);
        let response = f
            .client
            .get(callback)
            .header("cookie", cookies(started.headers()).join("; "))
            .send()
            .await
            .unwrap();
        assert!(
            response.headers()["location"]
                .to_str()
                .unwrap()
                .contains("auth_error"),
            "{failure}"
        );
        assert!(
            !cookies(response.headers())
                .iter()
                .any(|cookie| cookie.starts_with(&f.backend.config.cookie_name(SESSION_COOKIE)))
        );
        assert_eq!(f.rpc("getMe", "", json!({})).await.status(), 401);
    }
    f.close().await;
}
