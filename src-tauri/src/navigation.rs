//! Sending the SPA somewhere from the native side: a `matterwave://` link
//! opened from outside the app (the way back from Stripe included), a menu
//! or tray item, a click on a notification. The native side says *what* to open -- a
//! conversation, a share -- and the SPA decides *where* that is in its own
//! router, so a renamed route is the SPA's change alone.
//!
//! A request is kept until the SPA takes it (`take_navigation`) and
//! announced as the `navigate` event. The SPA takes on start-up and again on
//! every event, so a link that arrives before the page has loaded -- the
//! one that launched the app -- is opened once the page is up, and a link
//! that arrives later is opened exactly once.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The event the SPA listens for; the payload is empty, the request is
/// what `take_navigation` answers.
pub const NAVIGATE_EVENT: &str = "navigate";

/// Where the SPA is asked to go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Target {
    /// One conversation, optionally scrolled to one message.
    Conversation {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A shared conversation, by its share token.
    Share { token: String },
    /// Back from Stripe in the browser: the billing settings, which read the
    /// subscription afresh.
    Billing,
    /// An empty conversation, from the menu's New Chat.
    NewChat,
    /// The settings, from the menu's Settings.
    Settings,
}

/// The link's target, or nothing: only the shapes below open anything, and
/// every id is checked before it reaches the SPA. The sign-in callback is
/// not here -- it never leaves the native side (lib.rs).
///
/// - `matterwave://conversation/<id>[?m=<message id>]`
/// - `matterwave://share/<token>`
/// - `matterwave://billing/return`
pub fn from_deep_link(raw: &str) -> Option<Target> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != crate::DEEP_LINK_SCHEME {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let segments: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    match (host.as_str(), segments.as_slice()) {
        ("conversation", [id]) if is_id(id) => {
            let message = url
                .query_pairs()
                .find(|(k, _)| k == "m")
                .map(|(_, v)| v.into_owned())
                .filter(|m| is_id(m));
            Some(Target::Conversation {
                id: (*id).to_string(),
                message,
            })
        }
        ("share", [token]) if is_id(token) => Some(Target::Share {
            token: (*token).to_string(),
        }),
        ("billing", ["return"]) => Some(Target::Billing),
        _ => None,
    }
}

/// Ids and tokens as the platform mints them: URL-safe, bounded, nothing a
/// router could read as a path or a query.
pub(crate) fn is_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

static PENDING: std::sync::Mutex<Option<Target>> = std::sync::Mutex::new(None);

/// Ask the SPA to open `target`, replacing any request it has not taken:
/// the newest link is the one the person just clicked.
pub fn request(app: &AppHandle, target: Target) {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(target);
    }
    let _ = app.emit(NAVIGATE_EVENT, ());
}

/// The waiting request, taken: each one opens once.
pub fn take() -> Option<Target> {
    PENDING.lock().ok()?.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(id: &str, message: Option<&str>) -> Option<Target> {
        Some(Target::Conversation {
            id: id.into(),
            message: message.map(Into::into),
        })
    }

    #[test]
    fn a_conversation_link_opens_that_conversation() {
        assert_eq!(
            from_deep_link("matterwave://conversation/c_123-abc"),
            conversation("c_123-abc", None)
        );
        assert_eq!(
            from_deep_link("matterwave://conversation/c1/"),
            conversation("c1", None),
            "a trailing slash is the same link"
        );
        assert_eq!(
            from_deep_link("matterwave://Conversation/c1"),
            conversation("c1", None),
            "the host is case-insensitive"
        );
    }

    #[test]
    fn a_conversation_link_may_name_a_message() {
        assert_eq!(
            from_deep_link("matterwave://conversation/c1?m=m7"),
            conversation("c1", Some("m7"))
        );
        assert_eq!(
            from_deep_link("matterwave://conversation/c1?m=../x"),
            conversation("c1", None),
            "a malformed message id is dropped, the conversation still opens"
        );
    }

    #[test]
    fn a_share_link_opens_the_share() {
        assert_eq!(
            from_deep_link("matterwave://share/Zx9_-k"),
            Some(Target::Share {
                token: "Zx9_-k".into()
            })
        );
    }

    #[test]
    fn the_return_from_stripe_opens_billing() {
        assert_eq!(
            from_deep_link("matterwave://billing/return?session_id=cs_1"),
            Some(Target::Billing)
        );
        assert_eq!(from_deep_link("matterwave://billing"), None);
        assert_eq!(from_deep_link("matterwave://billing/portal"), None);
    }

    #[test]
    fn anything_else_opens_nothing() {
        for raw in [
            "matterwave://auth/callback?code=x&state=y",
            "matterwave://conversation",
            "matterwave://conversation/",
            "matterwave://conversation/a/b",
            "matterwave://conversation/a%2Fb",
            "matterwave://conversation/..",
            "matterwave://share/a b",
            "matterwave://settings/billing",
            "matterwave:conversation/c1",
            "https://app.example/conversation/c1",
            "javascript://conversation/c1",
            "not a url",
        ] {
            assert_eq!(from_deep_link(raw), None, "{raw}");
        }
        let long = format!("matterwave://conversation/{}", "a".repeat(129));
        assert_eq!(from_deep_link(&long), None);
    }

    #[test]
    fn the_spa_reads_the_kind_and_the_ids() {
        let json = serde_json::to_value(Target::Conversation {
            id: "c1".into(),
            message: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "conversation", "id": "c1"})
        );
        let json = serde_json::to_value(Target::Share { token: "t".into() }).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "share", "token": "t"}));
        let json = serde_json::to_value(Target::Billing).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "billing"}));
        let json = serde_json::to_value(Target::NewChat).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "new-chat"}));
        let json = serde_json::to_value(Target::Settings).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "settings"}));
    }

    /// One request, taken once; a newer one replaces an untaken older one.
    /// Serial in one test: the slot is process-wide.
    #[test]
    fn a_request_is_taken_once_and_the_newest_wins() {
        assert_eq!(take(), None);
        if let Ok(mut pending) = PENDING.lock() {
            *pending = conversation("old", None);
        }
        if let Ok(mut pending) = PENDING.lock() {
            *pending = conversation("new", None);
        }
        assert_eq!(take(), conversation("new", None));
        assert_eq!(take(), None);
    }
}
