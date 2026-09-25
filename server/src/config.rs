use reqwest::Url;

pub struct Config {
    pub database_url: String,
    pub client_id: String,
    pub api_key: String,
    pub redirect_uri: String,
    pub app_url: String,
    pub issuer: String,
    pub secure_cookies: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let required = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("Missing {name}; configure it in the root .env"))
        };
        let client_id = required("WORKOS_CLIENT_ID")?;
        let issuer = std::env::var("WORKOS_ISSUER")
            .unwrap_or_else(|_| default_issuer(&client_id))
            .trim_end_matches('/')
            .to_owned();
        let redirect_uri = required("WORKOS_REDIRECT_URI")?;
        let redirect = validate_url(&redirect_uri)?;
        if redirect.path() != "/api/auth/callback" {
            return Err("WORKOS_REDIRECT_URI must end with /api/auth/callback".into());
        }
        let origin = redirect.origin().ascii_serialization();
        let app_url = std::env::var("APP_URL").unwrap_or_else(|_| format!("{origin}/"));
        let app = validate_url(&app_url)?;
        if app.origin() != redirect.origin() || app.path() != "/" {
            return Err("APP_URL must be the root URL on the callback's origin".into());
        }
        Ok(Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres@localhost:5432/mindgrab".into()),
            client_id,
            api_key: required("WORKOS_API_KEY")?,
            redirect_uri,
            app_url: app.to_string(),
            issuer,
            secure_cookies: app.scheme() == "https",
        })
    }

    pub fn origin(&self) -> String {
        self.app_url.trim_end_matches('/').to_owned()
    }

    pub fn is_local(&self) -> bool {
        Url::parse(&self.app_url)
            .ok()
            .and_then(|app| app.host_str().map(is_loopback))
            .unwrap_or(false)
    }
}

pub(crate) fn default_issuer(client_id: &str) -> String {
    format!("https://api.workos.com/user_management/{client_id}")
}

fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid authentication URL")?;
    let local = url.host_str().is_some_and(is_loopback);
    if !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Authentication URLs require HTTPS (HTTP is allowed on loopback only), with no credentials, query, or fragment".into());
    }
    Ok(url)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_issuer_is_scoped_to_the_configured_workos_application() {
        assert_eq!(
            default_issuer("client_test"),
            "https://api.workos.com/user_management/client_test"
        );
        assert_ne!(
            default_issuer("client_test"),
            default_issuer("client_other")
        );
    }

    #[test]
    fn authentication_urls_require_https_except_on_loopback() {
        assert!(validate_url("http://localhost:5173/api/auth/callback").is_ok());
        assert!(validate_url("https://mindgrab.example/api/auth/callback").is_ok());
        for url in [
            "http://example.com/",
            "https://user:secret@example.com/",
            "https://example.com/?next=evil",
            "javascript:alert(1)",
        ] {
            assert!(validate_url(url).is_err());
        }
    }

    #[test]
    fn app_url_identifies_loopback_development() {
        for app_url in [
            "http://localhost:5173/",
            "http://127.0.0.1:5173/",
            "http://[::1]:5173/",
        ] {
            let config = Config {
                database_url: String::new(),
                client_id: String::new(),
                api_key: String::new(),
                redirect_uri: String::new(),
                app_url: app_url.to_owned(),
                issuer: String::new(),
                secure_cookies: false,
            };
            assert!(config.is_local(), "{app_url}");
        }

        let production = Config {
            database_url: String::new(),
            client_id: String::new(),
            api_key: String::new(),
            redirect_uri: String::new(),
            app_url: "https://mindgrab.example/".to_owned(),
            issuer: String::new(),
            secure_cookies: true,
        };
        assert!(!production.is_local());
    }
}
