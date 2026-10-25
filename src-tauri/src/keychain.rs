//! Tokens in the OS keychain (Keychain, Credential Manager, Secret Service).
//!
//! Two entries rather than one JSON blob: Windows caps a credential at 2560
//! bytes, and a JWT access token plus a refresh token can pass that. The
//! refresh token is the one that must survive a restart; if the access entry
//! cannot be written, the access token lives in memory until the next
//! refresh, which costs one round trip after a restart and nothing else.

use crate::tokens::TokenSet;
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.matterwave.desktop";
const ACCESS: &str = "access";
const REFRESH: &str = "refresh";

#[derive(Serialize, Deserialize)]
struct AccessEntry {
    access_token: String,
    expires_at: u64,
}

/// The two named secrets, behind a seam so the save/load/clear rules run in
/// a test without a credential manager: the OS stores need a desktop
/// session, and keyring's own mock keeps nothing between two `Entry::new`
/// calls, so it cannot show a round trip.
pub trait Store {
    fn get(&self, name: &str) -> Option<Vec<u8>>;
    fn put(&self, name: &str, secret: &[u8]) -> Result<(), String>;
    fn delete(&self, name: &str);
}

/// The OS keychain, through keyring.
struct Keychain;

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| format!("keychain: {e}"))
}

impl Store for Keychain {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        entry(name).ok()?.get_secret().ok()
    }

    fn put(&self, name: &str, secret: &[u8]) -> Result<(), String> {
        entry(name)?
            .set_secret(secret)
            .map_err(|e| format!("keychain: {e}"))
    }

    fn delete(&self, name: &str) {
        if let Ok(e) = entry(name) {
            let _ = e.delete_credential();
        }
    }
}

pub fn save(set: &TokenSet) -> Result<(), String> {
    save_in(&Keychain, set)
}

pub fn load() -> Option<TokenSet> {
    load_from(&Keychain)
}

pub fn clear() {
    clear_in(&Keychain)
}

pub(crate) fn save_in(store: &dyn Store, set: &TokenSet) -> Result<(), String> {
    match &set.refresh_token {
        Some(r) => store.put(REFRESH, r.as_bytes())?,
        None => store.delete(REFRESH),
    }
    let access = serde_json::to_vec(&AccessEntry {
        access_token: set.access_token.clone(),
        expires_at: set.expires_at,
    })
    .map_err(|e| e.to_string())?;
    if store.put(ACCESS, &access).is_err() {
        // Not fatal (module comment), but a stale copy must not be what the
        // next start restores.
        store.delete(ACCESS);
    }
    Ok(())
}

/// The stored set, if there is a refresh token. Without one nothing survives
/// expiry, so an access token alone is not worth restoring.
pub(crate) fn load_from(store: &dyn Store) -> Option<TokenSet> {
    let refresh = String::from_utf8(store.get(REFRESH)?).ok()?;
    let access = store
        .get(ACCESS)
        .and_then(|b| serde_json::from_slice::<AccessEntry>(&b).ok());
    Some(match access {
        Some(a) => TokenSet {
            access_token: a.access_token,
            refresh_token: Some(refresh),
            expires_at: a.expires_at,
        },
        // Expired on arrival: the first get_access_token refreshes.
        None => TokenSet {
            access_token: String::new(),
            refresh_token: Some(refresh),
            expires_at: 0,
        },
    })
}

pub(crate) fn clear_in(store: &dyn Store) {
    store.delete(ACCESS);
    store.delete(REFRESH);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// An in-memory store that can be told to refuse one entry's writes, the
    /// way Windows refuses an access entry over its size cap.
    #[derive(Default)]
    struct MemStore {
        entries: Mutex<HashMap<String, Vec<u8>>>,
        refuse: Mutex<Option<&'static str>>,
    }

    impl MemStore {
        fn refusing(name: &'static str) -> Self {
            let store = Self::default();
            *store.refuse.lock().unwrap() = Some(name);
            store
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = self.entries.lock().unwrap().keys().cloned().collect();
            names.sort();
            names
        }
    }

    impl Store for MemStore {
        fn get(&self, name: &str) -> Option<Vec<u8>> {
            self.entries.lock().unwrap().get(name).cloned()
        }

        fn put(&self, name: &str, secret: &[u8]) -> Result<(), String> {
            if *self.refuse.lock().unwrap() == Some(name) {
                return Err(format!("keychain: {name} refused"));
            }
            self.entries
                .lock()
                .unwrap()
                .insert(name.to_string(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, name: &str) {
            self.entries.lock().unwrap().remove(name);
        }
    }

    fn set() -> TokenSet {
        TokenSet {
            access_token: "at-1".into(),
            refresh_token: Some("rt-1".into()),
            expires_at: 4_102_444_800,
        }
    }

    #[test]
    fn a_saved_set_loads_back_from_two_entries() {
        let store = MemStore::default();
        save_in(&store, &set()).unwrap();
        assert_eq!(store.names(), vec![ACCESS.to_string(), REFRESH.to_string()]);
        assert_eq!(load_from(&store), Some(set()));
        // The refresh token is stored bare, so another keyring reader sees a
        // credential and not a JSON document.
        assert_eq!(store.get(REFRESH).unwrap(), b"rt-1");
    }

    #[test]
    fn nothing_loads_without_a_refresh_token() {
        let store = MemStore::default();
        assert_eq!(load_from(&store), None);
        let mut only_access = set();
        only_access.refresh_token = None;
        save_in(&store, &only_access).unwrap();
        assert_eq!(store.names(), vec![ACCESS.to_string()]);
        assert_eq!(load_from(&store), None);
    }

    #[test]
    fn a_set_without_a_refresh_token_removes_the_old_one() {
        let store = MemStore::default();
        save_in(&store, &set()).unwrap();
        let mut dropped = set();
        dropped.refresh_token = None;
        save_in(&store, &dropped).unwrap();
        assert_eq!(store.get(REFRESH), None);
    }

    #[test]
    fn a_refused_access_entry_is_not_fatal_and_loads_expired() {
        let store = MemStore::refusing(ACCESS);
        save_in(&store, &set()).unwrap();
        assert_eq!(store.names(), vec![REFRESH.to_string()]);
        let loaded = load_from(&store).unwrap();
        assert_eq!(loaded.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(loaded.access_token, "");
        assert_eq!(
            loaded.expires_at, 0,
            "expired on arrival, so the first call refreshes"
        );
    }

    #[test]
    fn a_refused_access_write_drops_the_stale_copy() {
        let store = MemStore::default();
        save_in(&store, &set()).unwrap();
        *store.refuse.lock().unwrap() = Some(ACCESS);
        let mut newer = set();
        newer.access_token = "at-2".into();
        newer.refresh_token = Some("rt-2".into());
        save_in(&store, &newer).unwrap();
        let loaded = load_from(&store).unwrap();
        assert_eq!(loaded.refresh_token.as_deref(), Some("rt-2"));
        assert_ne!(
            loaded.access_token, "at-1",
            "the old access token must not pair with the new refresh token"
        );
    }

    #[test]
    fn a_refused_refresh_entry_is_an_error() {
        let store = MemStore::refusing(REFRESH);
        assert!(save_in(&store, &set()).unwrap_err().contains("refresh"));
    }

    #[test]
    fn a_garbled_access_entry_loads_as_expired() {
        let store = MemStore::default();
        store.put(REFRESH, b"rt-1").unwrap();
        store.put(ACCESS, b"not json").unwrap();
        let loaded = load_from(&store).unwrap();
        assert_eq!(loaded.access_token, "");
        assert_eq!(loaded.expires_at, 0);
    }

    #[test]
    fn clear_removes_both_entries() {
        let store = MemStore::default();
        save_in(&store, &set()).unwrap();
        clear_in(&store);
        assert!(store.names().is_empty());
        assert_eq!(load_from(&store), None);
    }
}
