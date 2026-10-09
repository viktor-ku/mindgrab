use crate::error::{ApiError, Result};
use reqwest::Url;

#[derive(Clone)]
pub struct Config {
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
        let required = |key| {
            std::env::var(key)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Missing WorkOS configuration; configure .env")
        };
        let client_id = required("WORKOS_CLIENT_ID")?;
        let api_key = required("WORKOS_API_KEY")?;
        let redirect_uri = required("WORKOS_REDIRECT_URI")?;
        let redirect = Url::parse(&redirect_uri).map_err(|_| "Invalid callback URL")?;
        let app_url = std::env::var("APP_URL")
            .unwrap_or_else(|_| format!("{}/", redirect.origin().ascii_serialization()));
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
        let issuer = std::env::var("WORKOS_ISSUER")
            .unwrap_or_else(|_| format!("https://api.workos.com/user_management/{client_id}"));
        Ok(Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres@localhost:5432/mindgrab".into()),
            client_id,
            api_key,
            redirect_uri,
            app_url,
            issuer,
            provider_url: "https://api.workos.com".into(),
            secure_cookies: app.scheme() == "https",
        })
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
