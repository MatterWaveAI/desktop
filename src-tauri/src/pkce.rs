//! PKCE (RFC 7636) and the authorization request around it.
//!
//! The desktop app is a public client: there is no secret it could keep, so
//! the verifier is what proves the code redeemed at the token endpoint is the
//! one this process asked for. The `state` value ties the callback to this
//! sign-in, so a link from somewhere else cannot complete it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use url::Url;

/// 32 random bytes, base64url: 43 characters, the RFC's recommended size.
pub fn verifier() -> String {
    random_token(32)
}

/// The S256 challenge for a verifier. `plain` is never offered: it would put
/// the verifier itself in the browser's history.
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn state() -> String {
    random_token(16)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub struct AuthorizeRequest<'a> {
    pub endpoint: &'a str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scopes: &'a [String],
    pub challenge: &'a str,
    pub state: &'a str,
}

pub fn authorize_url(req: &AuthorizeRequest) -> Result<Url, String> {
    let mut url = Url::parse(req.endpoint).map_err(|e| format!("authorization endpoint: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", req.client_id)
        .append_pair("redirect_uri", req.redirect_uri)
        .append_pair("scope", &req.scopes.join(" "))
        .append_pair("code_challenge", req.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", req.state);
    Ok(url)
}

#[derive(Debug, PartialEq)]
pub enum CallbackError {
    /// Not a URL, or not the callback this sign-in registered.
    NotOurs,
    /// The state does not match: a stale tab or someone else's link.
    StateMismatch,
    /// The IdP answered with an error (`access_denied` when the person cancels).
    Denied(String),
    MissingCode,
}

/// The authorization code from a callback URL, once the URL is the redirect
/// this sign-in used and its state is ours. Checked before the code is
/// looked at, so a forged callback never reaches the token endpoint.
pub fn parse_callback(
    raw: &str,
    redirect_uri: &str,
    expected_state: &str,
) -> Result<String, CallbackError> {
    let got = Url::parse(raw).map_err(|_| CallbackError::NotOurs)?;
    let want = Url::parse(redirect_uri).map_err(|_| CallbackError::NotOurs)?;
    if got.scheme() != want.scheme()
        || got.host_str() != want.host_str()
        || got.port() != want.port()
        || got.path() != want.path()
    {
        return Err(CallbackError::NotOurs);
    }
    let param = |name: &str| {
        got.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    if param("state").as_deref() != Some(expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    if let Some(err) = param("error") {
        return Err(CallbackError::Denied(err));
    }
    param("code")
        .filter(|c| !c.is_empty())
        .ok_or(CallbackError::MissingCode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_the_rfc_vector() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_43_url_safe_chars_and_fresh_each_time() {
        let v = verifier();
        assert_eq!(v.len(), 43);
        assert!(v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(v, verifier());
    }

    #[test]
    fn authorize_url_carries_s256_and_state() {
        let scopes = vec!["openid".to_string(), "offline_access".to_string()];
        let url = authorize_url(&AuthorizeRequest {
            endpoint: "https://id.example.test/oauth/v2/authorize",
            client_id: "native",
            redirect_uri: "matterwave://auth/callback",
            scopes: &scopes,
            challenge: "abc",
            state: "xyz",
        })
        .unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "abc");
        assert_eq!(q["state"], "xyz");
        assert_eq!(q["scope"], "openid offline_access");
        assert_eq!(q["redirect_uri"], "matterwave://auth/callback");
    }

    #[test]
    fn callback_with_our_state_yields_the_code() {
        let code = parse_callback(
            "matterwave://auth/callback?code=c1&state=s1",
            "matterwave://auth/callback",
            "s1",
        );
        assert_eq!(code, Ok("c1".to_string()));
    }

    #[test]
    fn callback_with_another_state_is_refused() {
        let r = parse_callback(
            "matterwave://auth/callback?code=c1&state=other",
            "matterwave://auth/callback",
            "s1",
        );
        assert_eq!(r, Err(CallbackError::StateMismatch));
    }

    #[test]
    fn callback_for_another_redirect_is_not_ours() {
        let r = parse_callback(
            "matterwave://conversation/1?code=c1&state=s1",
            "matterwave://auth/callback",
            "s1",
        );
        assert_eq!(r, Err(CallbackError::NotOurs));
        let r = parse_callback(
            "http://127.0.0.1:5000/callback?code=c&state=s1",
            "http://127.0.0.1:5001/callback",
            "s1",
        );
        assert_eq!(r, Err(CallbackError::NotOurs));
    }

    #[test]
    fn cancelled_sign_in_reports_the_idp_error() {
        let r = parse_callback(
            "matterwave://auth/callback?error=access_denied&state=s1",
            "matterwave://auth/callback",
            "s1",
        );
        assert_eq!(r, Err(CallbackError::Denied("access_denied".into())));
    }
}
