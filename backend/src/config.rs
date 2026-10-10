use crate::error::{ApiError, Result};
use reqwest::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    WorkOs,
    Local,
}

#[derive(Clone)]
pub struct Config {
    pub auth_mode: AuthMode,
    pub database_url: String,
    pub client_id: String,
    pub api_key: String,
    pub redirect_uri: String,
    pub app_url: String,
    pub issuer: String,
    pub provider_url: String,
    pub secure_cookies: bool,
}
impl Config {
    pub fn from_env() -> std::result::Result<Self, &'static str> {
        Self::from_values(|key| std::env::var(key).ok(), cfg!(debug_assertions))
    }
    fn from_values(
        get: impl Fn(&str) -> Option<String>,
        development_build: bool,
    ) -> std::result::Result<Self, &'static str> {
        let auth_mode = match get("MINDGRAB_AUTH_MODE").as_deref().unwrap_or("workos") {
            "workos" => AuthMode::WorkOs,
            "local"
                if development_build && get("MINDGRAB_ENV").as_deref() == Some("development") =>
            {
                AuthMode::Local
            }
            "local" => {
                return Err(
                    "Local authentication requires a debug build and MINDGRAB_ENV=development",
                );
            }
            _ => return Err("MINDGRAB_AUTH_MODE must be workos or local"),
        };
        let required = |key| {
            get(key)
                .filter(|s| !s.trim().is_empty())
                .ok_or("Missing WorkOS configuration; configure .env")
        };
        let (client_id, api_key, redirect_uri, app_url) = match auth_mode {
            AuthMode::WorkOs => {
                let redirect_uri = required("WORKOS_REDIRECT_URI")?;
                let redirect = Url::parse(&redirect_uri).map_err(|_| "Invalid callback URL")?;
                let app_url = get("APP_URL")
                    .unwrap_or_else(|| format!("{}/", redirect.origin().ascii_serialization()));
                (
                    required("WORKOS_CLIENT_ID")?,
                    required("WORKOS_API_KEY")?,
                    redirect_uri,
                    app_url,
                )
            }
            AuthMode::Local => {
                let app_url = get("APP_URL").unwrap_or_else(|| {
                    format!(
                        "http://localhost:{}/",
                        get("WEBAPP_PORT").unwrap_or_else(|| "5173".into())
                    )
                });
                let app = Url::parse(&app_url).map_err(|_| "Invalid APP_URL")?;
                if !is_loopback(app.host_str().unwrap_or_default())
                    || get("HOST").is_some_and(|host| !is_loopback(&host))
                {
                    return Err("Local authentication requires loopback APP_URL and HOST");
                }
                let redirect_uri = app
                    .join("/api/auth/callback")
                    .map_err(|_| "Invalid callback URL")?
                    .to_string();
                (String::new(), String::new(), redirect_uri, app_url)
            }
        };
        let redirect = Url::parse(&redirect_uri).map_err(|_| "Invalid callback URL")?;
        let app = Url::parse(&app_url).map_err(|_| "Invalid APP_URL")?;
        for url in [&app, &redirect] {
            if !(url.scheme() == "https"
                || (url.scheme() == "http" && is_loopback(url.host_str().unwrap_or_default())))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Authentication URLs require HTTPS or loopback HTTP");
            }
        }
        if app.origin() != redirect.origin()
            || app.path() != "/"
            || redirect.path() != "/api/auth/callback"
        {
            return Err("APP_URL and callback must use the same origin");
        }
        let issuer = get("WORKOS_ISSUER")
            .unwrap_or_else(|| format!("https://api.workos.com/user_management/{client_id}"));
        Ok(Self {
            auth_mode,
            database_url: get("DATABASE_URL")
                .unwrap_or_else(|| "postgres://postgres@localhost:5432/mindgrab".into()),
            client_id,
            api_key,
            redirect_uri,
            app_url,
            issuer,
            provider_url: "https://api.workos.com".into(),
            secure_cookies: app.scheme() == "https",
        })
    }
    pub fn cookie_name(&self, base: &str) -> String {
        match self.auth_mode {
            AuthMode::WorkOs => base.to_owned(),
            // Cookies ignore ports. Scope local login and sessions to the worktree's app port.
            AuthMode::Local => format!(
                "{base}_local_{}",
                Url::parse(&self.app_url)
                    .unwrap()
                    .port_or_known_default()
                    .unwrap()
            ),
        }
    }
    pub fn origin(&self) -> String {
        Url::parse(&self.app_url)
            .unwrap()
            .origin()
            .ascii_serialization()
    }
    pub fn same_origin(&self, headers: &axum::http::HeaderMap) -> Result<()> {
        if headers.get_all("origin").iter().count() != 1
            || headers.get("origin").and_then(|v| v.to_str().ok()) != Some(self.origin().as_str())
        {
            return Err(ApiError::new(
                axum::http::StatusCode::FORBIDDEN,
                "invalid_origin",
            ));
        }
        Ok(())
    }
}
pub fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(
        values: &[(&str, &str)],
        development_build: bool,
    ) -> std::result::Result<Config, &'static str> {
        Config::from_values(
            |key| {
                values
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            },
            development_build,
        )
    }

    #[test]
    fn local_auth_needs_development_build_and_explicit_development_environment() {
        let local = [
            ("MINDGRAB_AUTH_MODE", "local"),
            ("MINDGRAB_ENV", "development"),
        ];
        assert!(config(&local, true).is_ok());
        assert!(config(&local, false).is_err());
        assert!(config(&[("MINDGRAB_AUTH_MODE", "local")], true).is_err());
        assert!(
            config(
                &[
                    ("MINDGRAB_AUTH_MODE", "local"),
                    ("MINDGRAB_ENV", "production")
                ],
                true
            )
            .is_err()
        );
        assert!(config(&[("MINDGRAB_AUTH_MODE", "typo")], true).is_err());
        assert!(config(&[], true).is_err()); // The default still requires WorkOS credentials.
    }

    #[test]
    fn local_urls_follow_the_worktree_without_workos_configuration() {
        let c = config(
            &[
                ("MINDGRAB_AUTH_MODE", "local"),
                ("MINDGRAB_ENV", "development"),
                ("WEBAPP_PORT", "24000"),
                (
                    "WORKOS_REDIRECT_URI",
                    "https://stale.example/api/auth/callback",
                ),
            ],
            true,
        )
        .unwrap();
        assert_eq!(c.app_url, "http://localhost:24000/");
        assert_eq!(c.redirect_uri, "http://localhost:24000/api/auth/callback");
        assert_eq!(c.cookie_name("session"), "session_local_24000");
        assert!(c.api_key.is_empty());
        assert!(c.client_id.is_empty());
    }

    #[test]
    fn local_auth_rejects_non_loopback_and_malformed_urls() {
        for (key, value) in [
            ("APP_URL", "https://mindgrab.example/"),
            ("APP_URL", "http://localhost.example/"),
            ("APP_URL", "http://localhost/path"),
            ("APP_URL", "http://localhost/?query=1"),
            ("APP_URL", "http://user@localhost/"),
            ("HOST", "0.0.0.0"),
            ("HOST", "::"),
        ] {
            assert!(
                config(
                    &[
                        ("MINDGRAB_AUTH_MODE", "local"),
                        ("MINDGRAB_ENV", "development"),
                        (key, value)
                    ],
                    true
                )
                .is_err(),
                "{key}={value}"
            );
        }
    }

    #[test]
    fn workos_keeps_its_configuration_and_cookie_names() {
        let c = config(
            &[
                ("WORKOS_CLIENT_ID", "client_test"),
                ("WORKOS_API_KEY", "secret"),
                (
                    "WORKOS_REDIRECT_URI",
                    "https://mindgrab.example/api/auth/callback",
                ),
            ],
            false,
        )
        .unwrap();
        assert_eq!(c.auth_mode, AuthMode::WorkOs);
        assert_eq!(c.app_url, "https://mindgrab.example/");
        assert_eq!(c.cookie_name("session"), "session");
    }
}
