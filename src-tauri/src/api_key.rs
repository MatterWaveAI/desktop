//! API keys: the second way in, beside the browser sign-in.
//!
//! The platform issues `mw_<8>_<secret>` keys (Settings -> API keys) for
//! scripts and other clients. A desktop build accepts one in place of the
//! OIDC dance for the person who provisions machines they never sit at --
//! CI boxes, a shared lab workstation -- with the trade the platform's key
//! page already states: a key acts as that account until it is revoked, with
//! no expiry and no refresh. Validation here is shape only; the API is what
//! decides whether a key still works, and a dead key surfaces as the 401 the
//! SPA already handles.

const PREFIX: &str = "mw_";
/// The id half is fixed-length, so a hint can show it and only it.
const ID_LEN: usize = 8;

/// Shape check for a pasted key: `mw_`, exactly eight id characters, `_`,
/// then a non-empty secret with no whitespace. Anything else is refused
/// before it reaches the keychain, because a mis-pasted key stored
/// successfully looks exactly like a working one until every request 401s.
/// Trimming is the caller's (`set_api_key`); a space inside the key is a
/// fact about the key, padding around a paste is a fact about the paste.
pub fn validate(key: &str) -> Result<(), String> {
    let rest = key
        .strip_prefix(PREFIX)
        .ok_or_else(|| format!("an API key starts with {PREFIX}"))?;
    let (id, secret) = rest
        .split_once('_')
        .ok_or_else(|| format!("an API key is {PREFIX}<id>_<secret>"))?;
    if id.len() != ID_LEN {
        return Err(format!(
            "an API key's id is {ID_LEN} characters; this one has {}",
            id.len()
        ));
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("an API key's id is letters and digits".into());
    }
    if secret.is_empty() {
        return Err("an API key ends with its secret, after the underscore".into());
    }
    if key.contains(char::is_whitespace) {
        return Err("an API key has no spaces or line breaks; paste it again".into());
    }
    Ok(())
}

/// What the settings screen shows instead of the key: the id half plus an
/// ellipsis. The secret never comes back out of the keychain once stored,
/// so this is all a saved key can be rendered as.
pub fn hint(key: &str) -> String {
    let mut end = (PREFIX.len() + ID_LEN).min(key.len());
    while !key.is_char_boundary(end) {
        end += 1;
    }
    format!("{}\u{2026}", &key[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_platform_shaped_key_passes() {
        assert!(validate("mw_ab12cd34_s3cr3tvalue").is_ok());
        assert!(validate("mw_00000000_A").is_ok());
        assert!(validate("mw_ZZ9nine9_with-dashes_and.dots").is_ok());
    }

    #[test]
    fn a_mangled_paste_is_named() {
        for (key, expected) in [
            ("", "mw_"),
            ("not-a-key", "mw_"),
            ("mw_ab12cd34", "secret"),
            ("mw_ab12cd34_", "secret"),
            ("mw_ab1cd34_secret", "8 characters"),
            ("mw_ab12*!34_secret", "letters and digits"),
            ("mw_ab12cd34_two words", "no spaces"),
            ("mw_ab12cd34_secret\nmore", "no spaces"),
        ] {
            let err = validate(key).unwrap_err();
            assert!(err.contains(expected), "{key:?}: {err}");
        }
    }

    #[test]
    fn the_hint_shows_the_id_half_only() {
        assert_eq!(hint("mw_ab12cd34_secret"), "mw_ab12cd34\u{2026}");
        assert_eq!(hint("short"), "short\u{2026}");
    }
}
