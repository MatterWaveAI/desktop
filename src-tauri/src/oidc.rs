//! The native OIDC client: discovery from the API, then the token endpoint.
//!
//! The client id and endpoints come from `/api/auth-config` rather than the
//! build, so a Zitadel re-provision changes nothing on installed machines.

use crate::tokens::{parse_token_response, TokenError, TokenSet};
use serde::Deserialize;

/// Scopes the desktop needs whatever the API lists: `offline_access` is what
/// gets a refresh token, without which every restart is a sign-in.
const REQUIRED_SCOPES: [&str; 2] = ["openid", "offline_access"];

#[derive(Deserialize, Default)]
pub struct AuthConfig {
    #[serde(default)]
    pub native_client_id: Option<String>,
    #[serde(default)]
    pub authorization_endpoint: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeClient {
    pub client_id: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub scopes: Vec<String>,
}

impl NativeClient {
    pub fn from_config(cfg: AuthConfig) -> Result<Self, String> {
        let missing =
            |f: &str| format!("/api/auth-config has no {f}; is the native client provisioned?");
        let client_id = cfg
            .native_client_id
            .filter(|s| !s.is_empty())
            .ok_or_else(|| missing("native_client_id"))?;
        let authorization_endpoint = cfg
            .authorization_endpoint
            .ok_or_else(|| missing("authorization_endpoint"))?;
        let token_endpoint = cfg
            .token_endpoint
            .ok_or_else(|| missing("token_endpoint"))?;
        let mut scopes = cfg.scopes.unwrap_or_default();
        for s in REQUIRED_SCOPES {
            if !scopes.iter().any(|have| have == s) {
                scopes.push(s.to_string());
            }
        }
        let revocation_endpoint = cfg
            .revocation_endpoint
            .or_else(|| sibling_revoke(&token_endpoint));
        Ok(Self {
            client_id,
            authorization_endpoint,
            token_endpoint,
            revocation_endpoint,
            scopes,
        })
    }
}

/// Zitadel serves revoke beside token (`/oauth/v2/token` -> `/oauth/v2/revoke`);
/// the API's auth-config does not list it yet, and a sign-out that cannot
/// revoke leaves a live refresh token behind.
fn sibling_revoke(token_endpoint: &str) -> Option<String> {
    token_endpoint
        .strip_suffix("/token")
        .map(|base| format!("{base}/revoke"))
}

pub async fn discover(http: &reqwest::Client, base_url: &str) -> Result<NativeClient, String> {
    let url = format!("{}/api/auth-config", base_url.trim_end_matches('/'));
    let cfg: AuthConfig = http
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("auth-config: {e}"))?
        .json()
        .await
        .map_err(|e| format!("auth-config: {e}"))?;
    NativeClient::from_config(cfg)
}

#[derive(Debug)]
pub enum RefreshError {
    /// The grant is dead; clear the keychain.
    Rejected(String),
    /// Network or server trouble; keep the tokens and try later.
    Transient(String),
}

async fn post_token(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
    previous_refresh: Option<&str>,
) -> Result<TokenSet, RefreshError> {
    let resp = http
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|e| RefreshError::Transient(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| RefreshError::Transient(e.to_string()))?;
    if status.is_server_error() {
        return Err(RefreshError::Transient(format!("token endpoint {status}")));
    }
    parse_token_response(&body, crate::now(), previous_refresh).map_err(|e| match e {
        TokenError::Rejected(m) => RefreshError::Rejected(m),
        TokenError::Malformed(m) => RefreshError::Transient(m),
    })
}

pub async fn exchange_code(
    http: &reqwest::Client,
    client: &NativeClient,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenSet, String> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("client_id", client.client_id.as_str()),
    ];
    post_token(http, &client.token_endpoint, &form, None)
        .await
        .map_err(|e| match e {
            RefreshError::Rejected(m) => format!("sign-in refused: {m}"),
            RefreshError::Transient(m) => format!("token endpoint: {m}"),
        })
}

pub async fn refresh(
    http: &reqwest::Client,
    client: &NativeClient,
    refresh_token: &str,
) -> Result<TokenSet, RefreshError> {
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client.client_id.as_str()),
    ];
    post_token(http, &client.token_endpoint, &form, Some(refresh_token)).await
}

/// Best effort: sign-out clears the keychain whether or not this reaches the
/// IdP, because a person who pressed "sign out" offline is still signed out
/// on this machine.
pub async fn revoke(http: &reqwest::Client, client: &NativeClient, token: &str, hint: &str) {
    if let Some(endpoint) = &client.revocation_endpoint {
        let form = [
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", client.client_id.as_str()),
        ];
        let _ = http.post(endpoint).form(&form).send().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AuthConfig {
        AuthConfig {
            native_client_id: Some("native-1".into()),
            authorization_endpoint: Some("https://id.example.test/oauth/v2/authorize".into()),
            token_endpoint: Some("https://id.example.test/oauth/v2/token".into()),
            revocation_endpoint: None,
            scopes: Some(vec!["openid".into(), "profile".into()]),
        }
    }

    #[test]
    fn config_adds_offline_access_and_derives_revoke() {
        let c = NativeClient::from_config(cfg()).unwrap();
        assert_eq!(c.scopes, vec!["openid", "profile", "offline_access"]);
        assert_eq!(
            c.revocation_endpoint.as_deref(),
            Some("https://id.example.test/oauth/v2/revoke")
        );
    }

    #[test]
    fn config_without_a_native_client_is_an_error_not_a_web_fallback() {
        let mut c = cfg();
        c.native_client_id = None;
        assert!(NativeClient::from_config(c)
            .unwrap_err()
            .contains("native_client_id"));
    }

    #[test]
    fn auth_config_json_ignores_web_only_fields() {
        let json = r#"{"auth_mode":"oidc","client_id":"web","native_client_id":"n","authorization_endpoint":"https://i/a","token_endpoint":"https://i/token"}"#;
        let c = NativeClient::from_config(serde_json::from_str(json).unwrap()).unwrap();
        assert_eq!(c.client_id, "n");
    }
}
