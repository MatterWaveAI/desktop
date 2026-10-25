//! The token set and when to refresh it.
//!
//! Times are unix seconds passed in by the caller, so the decisions here are
//! plain functions a test can drive without a clock.

use serde::{Deserialize, Serialize};

/// Refresh this long before the access token expires. A request started a
/// second before expiry would otherwise reach the API with a dead token and
/// spend its one 401 retry on something that was foreseeable.
pub const REFRESH_AHEAD_SECS: u64 = 60;

/// Assumed lifetime when the token endpoint omits `expires_in` (it is
/// optional in RFC 6749). Short on purpose: guessing long would hand out an
/// expired token; guessing short only costs an early refresh.
const DEFAULT_LIFETIME_SECS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds.
    pub expires_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum TokenError {
    /// `invalid_grant` and friends: the grant is dead (revoked device,
    /// expired refresh token). The person has to sign in again.
    Rejected(String),
    /// Not a token response at all.
    Malformed(String),
}

/// Parse a token endpoint body. `previous_refresh` is kept when a refresh
/// response does not rotate the refresh token, which the spec allows; losing
/// it there would sign the person out at the next expiry for no reason.
pub fn parse_token_response(
    body: &str,
    now: u64,
    previous_refresh: Option<&str>,
) -> Result<TokenSet, TokenError> {
    if let Ok(err) = serde_json::from_str::<ErrorResponse>(body) {
        let detail = match err.error_description {
            Some(d) => format!("{}: {d}", err.error),
            None => err.error,
        };
        return Err(TokenError::Rejected(detail));
    }
    let resp: TokenResponse =
        serde_json::from_str(body).map_err(|e| TokenError::Malformed(e.to_string()))?;
    // The API only accepts bearer tokens; anything else would be sent and
    // refused on every request.
    if let Some(t) = resp.token_type.as_deref() {
        if !t.eq_ignore_ascii_case("bearer") {
            return Err(TokenError::Malformed(format!("token_type {t}")));
        }
    }
    if resp.access_token.is_empty() {
        return Err(TokenError::Malformed("empty access_token".into()));
    }
    Ok(TokenSet {
        access_token: resp.access_token,
        refresh_token: resp
            .refresh_token
            .filter(|r| !r.is_empty())
            .or_else(|| previous_refresh.map(str::to_owned)),
        expires_at: now + resp.expires_in.unwrap_or(DEFAULT_LIFETIME_SECS),
    })
}

/// Whether to refresh before handing the access token out. `force` is the
/// SPA's one retry after a 401: the API said no, so the clock is not trusted.
pub fn should_refresh(set: &TokenSet, now: u64, force: bool) -> bool {
    set.refresh_token.is_some() && (force || now + REFRESH_AHEAD_SECS >= set.expires_at)
}

pub fn is_expired(set: &TokenSet, now: u64) -> bool {
    now >= set.expires_at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_response() {
        let body = r#"{"access_token":"a","token_type":"Bearer","expires_in":3600,"refresh_token":"r","id_token":"i"}"#;
        let set = parse_token_response(body, 1000, None).unwrap();
        let want = TokenSet {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: 4600,
        };
        assert_eq!(set, want);
    }

    #[test]
    fn keeps_the_old_refresh_token_when_not_rotated() {
        let set = parse_token_response(r#"{"access_token":"a2","expires_in":60}"#, 0, Some("r1"));
        assert_eq!(set.unwrap().refresh_token.as_deref(), Some("r1"));
    }

    #[test]
    fn missing_expiry_assumes_a_short_lifetime() {
        let set = parse_token_response(r#"{"access_token":"a"}"#, 10, None).unwrap();
        assert_eq!(set.expires_at, 10 + DEFAULT_LIFETIME_SECS);
    }

    #[test]
    fn an_error_body_is_a_rejection() {
        let body = r#"{"error":"invalid_grant","error_description":"revoked"}"#;
        let r = parse_token_response(body, 0, None);
        assert_eq!(
            r,
            Err(TokenError::Rejected("invalid_grant: revoked".into()))
        );
    }

    #[test]
    fn a_non_bearer_or_garbage_body_is_malformed() {
        let mac = parse_token_response(r#"{"access_token":"a","token_type":"mac"}"#, 0, None);
        assert!(matches!(mac, Err(TokenError::Malformed(_))));
        assert!(matches!(
            parse_token_response("<html>", 0, None),
            Err(TokenError::Malformed(_))
        ));
    }

    #[test]
    fn refreshes_ahead_of_expiry_only_with_a_refresh_token() {
        let mut set = TokenSet {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: 1000,
        };
        assert!(!should_refresh(&set, 1000 - REFRESH_AHEAD_SECS - 1, false));
        assert!(should_refresh(&set, 1000 - REFRESH_AHEAD_SECS, false));
        assert!(
            should_refresh(&set, 0, true),
            "a 401 forces a refresh whatever the clock says"
        );
        set.refresh_token = None;
        assert!(!should_refresh(&set, 2000, true));
        assert!(is_expired(&set, 1000));
    }
}
