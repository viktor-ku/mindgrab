use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::Config;

#[derive(Debug, PartialEq)]
pub enum AuthError {
    BadRequest,
    Unauthorized,
    Unavailable,
}

#[derive(Deserialize)]
pub struct WorkOsUser {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

impl WorkOsUser {
    pub fn name(&self) -> String {
        let name = [self.first_name.as_deref(), self.last_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_owned();
        if name.is_empty() {
            self.email.clone()
        } else {
            name
        }
    }
}

#[derive(Deserialize)]
pub struct Authentication {
    pub user: WorkOsUser,
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Clone, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub sid: String,
    pub exp: u64,
    pub client_id: String,
}

pub struct WorkOs {
    client: Client,
    api_base: String,
    client_id: String,
    api_key: String,
    issuer: String,
    keys: Mutex<Option<(Instant, JwkSet)>>,
}

impl WorkOs {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            api_base: "https://api.workos.com".into(),
            client_id: config.client_id.clone(),
            api_key: config.api_key.clone(),
            issuer: config.issuer.clone(),
            keys: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn with_test_endpoint(mut self, endpoint: String) -> Self {
        self.api_base = endpoint;
        self
    }

    pub fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> Url {
        let mut url = Url::parse(&format!("{}/user_management/authorize", self.api_base)).unwrap();
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("provider", "authkit"),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ]);
        url
    }

    pub fn logout_url(&self, session_id: &str, return_to: &str) -> Url {
        let mut url = Url::parse(&format!(
            "{}/user_management/sessions/logout",
            self.api_base
        ))
        .unwrap();
        url.query_pairs_mut()
            .extend_pairs([("session_id", session_id), ("return_to", return_to)]);
        url
    }

    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<Authentication, AuthError> {
        self.authenticate(json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        }))
        .await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<Authentication, AuthError> {
        let body = json!({"grant_type": "refresh_token", "refresh_token": refresh_token});
        // A bounded retry fits inside WorkOS's refresh replay grace period.
        let mut result = self.authenticate(body.clone()).await;
        if matches!(result, Err(AuthError::Unavailable)) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            result = self.authenticate(body).await;
        }
        result
    }

    async fn authenticate(&self, mut body: Value) -> Result<Authentication, AuthError> {
        body["client_id"] = self.client_id.clone().into();
        body["client_secret"] = self.api_key.clone().into();
        let response = self
            .client
            .post(format!("{}/user_management/authenticate", self.api_base))
            .json(&body)
            .send()
            .await
            .map_err(|_| AuthError::Unavailable)?;
        if !response.status().is_success() {
            let status = response.status();
            eprintln!("WorkOS authentication request failed: HTTP {status}");
            let body: Value = response.json().await.unwrap_or(Value::Null);
            // Retain sessions on network, rate-limit, and configuration failures.
            // Only an explicit invalid grant establishes that a session is over.
            return Err(
                if status == StatusCode::BAD_REQUEST && body["error"] == "invalid_grant" {
                    AuthError::Unauthorized
                } else {
                    AuthError::Unavailable
                },
            );
        }
        response.json().await.map_err(|_| {
            eprintln!("WorkOS authentication response could not be decoded");
            AuthError::Unavailable
        })
    }

    pub async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        let header = decode_header(token).map_err(|_| AuthError::Unauthorized)?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::Unauthorized);
        }
        let kid = header.kid.ok_or(AuthError::Unauthorized)?;
        let mut cache = self.keys.lock().await;
        let needs_refresh = cache.as_ref().is_none_or(|(time, keys)| {
            time.elapsed() > Duration::from_secs(3600) || keys.find(&kid).is_none()
        });
        if needs_refresh {
            let response = self
                .client
                .get(format!("{}/sso/jwks/{}", self.api_base, self.client_id))
                .send()
                .await
                .map_err(|_| AuthError::Unavailable)?
                .error_for_status()
                .map_err(|_| AuthError::Unavailable)?;
            let keys = response.json().await.map_err(|_| AuthError::Unavailable)?;
            *cache = Some((Instant::now(), keys));
        }
        let jwk = cache
            .as_ref()
            .and_then(|(_, keys)| keys.find(&kid))
            .ok_or(AuthError::Unauthorized)?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| AuthError::Unauthorized)?;
        drop(cache);
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[self.issuer.clone(), format!("{}/", self.issuer)]);
        validation.set_audience(&[&self.client_id]);
        validation.set_required_spec_claims(&["exp", "iss", "sub"]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        // Expiry is enforced by callers, which may refresh a signed expired token.
        validation.validate_exp = false;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|error| {
                // Error kinds identify validation failures without logging JWTs or claims.
                use jsonwebtoken::errors::ErrorKind;
                let reason = match error.kind() {
                    ErrorKind::Json(_) => "invalid or missing claim",
                    ErrorKind::InvalidIssuer => "issuer mismatch",
                    ErrorKind::InvalidAudience => "audience mismatch",
                    ErrorKind::InvalidSignature => "invalid signature",
                    ErrorKind::ImmatureSignature => "token not yet valid",
                    _ => "invalid token",
                };
                eprintln!("WorkOS access token validation failed: {reason}");
                AuthError::Unauthorized
            })?
            .claims;
        if claims.client_id != self.client_id || claims.sub.is_empty() || claims.sid.is_empty() {
            return Err(AuthError::Unauthorized);
        }
        Ok(claims)
    }
}
