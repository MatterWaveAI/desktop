//! Pairing this machine as a device: the desktop's half of the edge
//! handshake (api/matterwave/edge_pairing.py).
//!
//! The platform mints a once-usable, ten-minute code (Settings -> Devices,
//! `POST /api/sync/pairings`); this side redeems it at `POST /api/sync/pair`
//! -- anonymous on purpose, the code is the credential -- and keeps what
//! comes back in the OS keychain, the desktop's pairing.json: a device key
//! holding exactly `conversations:import`, plus the metadata shown beside
//! it. The box's own route (`/api/sync/box/pairing`) is `MW_ENV=edge` only
//! and 404s on a platform pod, so the redeem goes to the platform directly.
//!
//! The key is NOT the app's bearer: it may only add conversations, and the
//! app's requests keep the sign-in token (lib.rs). It registers the machine
//! as one of the org's devices -- listed beside the paired boxes on the
//! platform's Devices pane, revocable there or here.

use crate::api_key;
use crate::keychain::{self, Store};
use serde::{Deserialize, Serialize};

/// Twelve Crockford characters, the alphabet edge_pairing.py mints from. O,
/// I and L are translated, not refused: the code is typed by hand.
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 12;

/// The shape of a code as the person pasted it, to what the route wants:
/// dashes and spaces out, upper case, the ambiguous letters folded. None is
/// a shape the platform will refuse anyway, so the caller can say so before
/// the network trip.
pub(crate) fn normalize_code(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .map(|c| c.to_ascii_uppercase())
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    if chars.len() != CODE_LEN
        || !chars
            .iter()
            .all(|c| c.is_ascii() && ALPHABET.contains(&(*c as u8)))
    {
        return None;
    }
    Some(chars.into_iter().collect())
}

/// What the keychain holds beside the key: everything the Devices pane
/// shows, and nothing secret.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct PairingMeta {
    pub key_id: String,
    /// The name the code was minted with, as the platform's Devices pane
    /// named it.
    pub name: Option<String>,
    /// Stable per machine: a re-pairing keeps it, so the platform keeps
    /// telling this device apart -- the box's rule too.
    pub device_id: String,
    /// Unix seconds.
    pub paired_at: u64,
}

/// The platform's answer to a redemption: the plaintext key, once, and who
/// it belongs to.
#[derive(Deserialize)]
struct Redeemed {
    key: String,
    key_id: String,
    name: Option<String>,
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A v4-shaped UUID from `rand`: the platform stores it opaque (a string of
/// up to 64 characters) and echoes it back with each import.
fn new_device_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The stored pairing, when both halves are there and the metadata parses.
pub(crate) fn load_meta_from(store: &dyn Store) -> Option<PairingMeta> {
    let (_, meta_json) = keychain::load_device_pairing_in(store)?;
    serde_json::from_str(&meta_json).ok()
}

pub(crate) fn load_meta() -> Option<PairingMeta> {
    let (_, meta_json) = keychain::load_device_pairing()?;
    serde_json::from_str(&meta_json).ok()
}

/// Redeem `code` against `base` and store the pairing. Errors carry what
/// the person can act on: a mangled code, an unreachable platform, or the
/// route's own refusal in its own words. The store is `Send + Sync` so the
/// future is: the Tauri command awaits this with the store borrowed across
/// the HTTP round trip.
pub(crate) async fn pair_with(
    store: &(dyn Store + Send + Sync),
    http: &reqwest::Client,
    base: &str,
    code: &str,
) -> Result<PairingMeta, String> {
    let normalized = normalize_code(code).ok_or_else(|| {
        "A pairing code is twelve letters and digits, like ABCD-EFGH-JKMN.".to_string()
    })?;
    // The device id survives a re-pairing; the platform keeps telling this
    // machine apart from whatever paired here before.
    let device_id = load_meta_from(store)
        .map(|meta| meta.device_id)
        .unwrap_or_else(new_device_id);
    let url = format!("{}/api/sync/pair", base.trim_end_matches('/'));
    let response = http
        .post(&url)
        .json(&serde_json::json!({ "code": normalized, "device_id": device_id }))
        .send()
        .await
        .map_err(|e| format!("could not reach the platform: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        // Unknown, expired and already used are one answer (404) by design;
        // the route's wording is the one to show.
        let detail = body
            .get("detail")
            .and_then(|d| d.as_str())
            .unwrap_or("That pairing code is not valid, or it has expired. Make a new one.");
        return Err(detail.to_string());
    }
    let redeemed: Redeemed = serde_json::from_value(body)
        .map_err(|_| "the platform's answer carried no device key".to_string())?;
    // The key is a platform key (`mw_<id>_<secret>`); the shape check keeps
    // a mangled answer out of the keychain, as it does a mangled paste.
    api_key::validate(&redeemed.key)?;
    let meta = PairingMeta {
        key_id: redeemed.key_id,
        name: redeemed.name,
        device_id,
        paired_at: now(),
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    keychain::save_device_pairing_in(store, &redeemed.key, &meta_json)?;
    Ok(meta)
}

pub(crate) async fn pair(
    http: &reqwest::Client,
    base: &str,
    code: &str,
) -> Result<PairingMeta, String> {
    pair_with(&keychain::KeychainStore, http, base, code).await
}

/// Revoke the device key on the platform -- a key may always revoke itself,
/// so the pairing key carries its own authority for this one call -- then
/// forget the pairing whatever happened, the box's rule too: an offline
/// unpair still unpairs, and says the key outlives it until an admin
/// revokes it. `Ok(false)` is nothing stored to unpair.
pub(crate) async fn unpair_with(
    store: &(dyn Store + Send + Sync),
    http: &reqwest::Client,
    base: &str,
) -> Result<bool, String> {
    let Some((key, meta_json)) = keychain::load_device_pairing_in(store) else {
        return Ok(false);
    };
    let mut revoked = false;
    if let Ok(meta) = serde_json::from_str::<PairingMeta>(&meta_json) {
        let url = format!(
            "{}/api/keys/{}",
            base.trim_end_matches('/'),
            urlencode(&meta.key_id)
        );
        if let Ok(response) = http.delete(&url).bearer_auth(&key).send().await {
            let status = response.status().as_u16();
            // 401/404 count: the key is gone either way -- gone already is gone.
            revoked = matches!(status, 200..=299 | 401 | 404);
        }
    }
    keychain::clear_device_pairing_in(store);
    Ok(revoked)
}

pub(crate) async fn unpair(http: &reqwest::Client, base: &str) -> Result<bool, String> {
    unpair_with(&keychain::KeychainStore, http, base).await
}

/// Percent-encode one path segment, for the key id in the revoke URL.
fn urlencode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::MemStore;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn a_typed_code_normalizes_the_way_the_platform_reads_it() {
        assert_eq!(
            normalize_code("ABCD-EFGH-JKMN").as_deref(),
            Some("ABCDEFGHJKMN")
        );
        // Lower case, spaces, the Crockford aliases folded.
        assert_eq!(
            normalize_code("abcd efgh jkmn").as_deref(),
            Some("ABCDEFGHJKMN")
        );
        assert_eq!(
            normalize_code("OIL0-FGH2-JKMN").as_deref(),
            Some("0110FGH2JKMN")
        );
        assert_eq!(
            normalize_code("abcd-efgh-jkmn").as_deref(),
            Some("ABCDEFGHJKMN")
        );
    }

    #[test]
    fn anything_else_is_refused_before_the_network_trip() {
        assert_eq!(normalize_code(""), None);
        assert_eq!(normalize_code("ABCD-EFGH-JKM"), None, "eleven");
        assert_eq!(normalize_code("ABCD-EFGH-JKMNN"), None, "thirteen");
        assert_eq!(
            normalize_code("ABCD-EFGH-JKMu"),
            None,
            "not in the alphabet"
        );
        assert_eq!(normalize_code("ABCD-EFGH-JK\u{00e9}"), None, "not ascii");
    }

    #[test]
    fn a_device_id_is_a_uuid_the_platform_can_store() {
        let id = new_device_id();
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
        assert!(parts[2].starts_with('4'), "version 4: {id}");
        let variant = u8::from_str_radix(&parts[3][0..1], 16).unwrap();
        assert!(variant & 0b1100 == 0b1000, "RFC 4122 variant: {id}");
        // And two draws differ.
        assert_ne!(new_device_id(), new_device_id());
    }

    /// One-request server on loopback: answers `answer` for the redeem (or
    /// the revoke) and records what it saw, the way sign-in tests run a
    /// fake issuer.
    struct FakeApi {
        base: String,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String, String)>>>, // method, path, body
    }

    impl FakeApi {
        async fn start(answer: String) -> Self {
            Self::start_many(move |method, path, body| {
                let _ = (method, path, body);
                answer.clone()
            })
            .await
        }

        async fn start_many(
            answer: impl Fn(String, String, String) -> String + Send + Sync + 'static,
        ) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let api = Self {
                base,
                seen: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            };
            let serving = std::sync::Arc::new(answer);
            let seen = api.seen.clone();
            tokio::spawn(async move {
                while let Ok((mut sock, _)) = listener.accept().await {
                    let answer = serving.clone();
                    let seen = seen.clone();
                    // One request per connection: read the head and the
                    // declared body, record it, answer, close.
                    let (method, path, body) = read_request(&mut sock).await;
                    seen.lock()
                        .unwrap()
                        .push((method.clone(), path.clone(), body.clone()));
                    let response = answer(method, path, body);
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.shutdown().await;
                }
            });
            api
        }

        fn calls(&self) -> Vec<(String, String, String)> {
            self.seen.lock().unwrap().clone()
        }
    }

    async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, String, String) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).into_owned();
                let length = head
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let body_start = end + 4;
                while buf.len() < body_start + length {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let mut parts = head.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let body = String::from_utf8_lossy(&buf[body_start..]).into_owned();
                return (method, path, body);
            }
            if n == 0 {
                return (String::new(), String::new(), String::new());
            }
        }
    }

    fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    fn ok_json(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn a_code_redeems_to_a_stored_pairing() {
        let api = FakeApi::start(ok_json(
            r#"{"key":"mw_ab12cd34_s3cr3t","key_id":"k-1","name":"David's laptop","scopes":["conversations:import"]}"#,
        ))
        .await;
        let store = MemStore::default();

        let meta = pair_with(&store, &http(), &api.base, "abcd-efgh-jkmn")
            .await
            .unwrap();

        // The route saw the normalized code and a device id.
        let calls = api.calls();
        assert_eq!(calls.len(), 1);
        let (method, path, body) = &calls[0];
        assert_eq!(method, "POST");
        assert_eq!(path, "/api/sync/pair");
        let sent: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(sent["code"], "ABCDEFGHJKMN");
        assert!(sent["device_id"].as_str().unwrap().len() == 36);

        assert_eq!(meta.name.as_deref(), Some("David's laptop"));
        assert_eq!(meta.key_id, "k-1");
        assert_eq!(sent["device_id"], meta.device_id.as_str());
        assert!(meta.paired_at > 0);

        // Both halves in the store: key bare, metadata beside it.
        let (key, meta_json) = keychain::load_device_pairing_in(&store).unwrap();
        assert_eq!(key, "mw_ab12cd34_s3cr3t");
        let stored: PairingMeta = serde_json::from_str(&meta_json).unwrap();
        assert_eq!(stored, meta);

        // And a re-pairing keeps the device id.
        let api2 = FakeApi::start(ok_json(
            r#"{"key":"mw_ab12cd34_s3cr3t","key_id":"k-2","name":null}"#,
        ))
        .await;
        let again = pair_with(&store, &http(), &api2.base, "WXYZ-WXYZ-WXYZ")
            .await
            .unwrap();
        assert_eq!(again.device_id, meta.device_id);
        assert_eq!(again.key_id, "k-2");
    }

    #[tokio::test]
    async fn the_platform_s_refusal_is_the_error_shown() {
        let detail = "That pairing code is not valid, or it has expired. Make a new one.";
        let body = format!(r#"{{"detail":"{detail}"}}"#);
        let answer = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let api = FakeApi::start(answer).await;
        let store = MemStore::default();

        let err = pair_with(&store, &http(), &api.base, "ABCD-EFGH-JKMN")
            .await
            .unwrap_err();
        assert_eq!(err, detail);
        assert!(
            keychain::load_device_pairing_in(&store).is_none(),
            "a refused code stores nothing"
        );
    }

    #[tokio::test]
    async fn a_mangled_code_is_refused_without_reaching_the_platform() {
        let api = FakeApi::start(ok_json(r#"{"key":"mw_ab12cd34_s","key_id":"k"}"#)).await;
        let store = MemStore::default();
        let err = pair_with(&store, &http(), &api.base, "short")
            .await
            .unwrap_err();
        assert!(err.contains("twelve letters"), "{err}");
        assert!(api.calls().is_empty());
    }

    #[tokio::test]
    async fn an_answer_without_a_usable_key_stores_nothing() {
        // The platform's key shape is `mw_<id>_<secret>`; anything else is
        // not a key to keep, even wrapped in a 200.
        let api = FakeApi::start(ok_json(r#"{"key":"not-a-key","key_id":"k-1"}"#)).await;
        let store = MemStore::default();
        let err = pair_with(&store, &http(), &api.base, "ABCD-EFGH-JKMN")
            .await
            .unwrap_err();
        assert!(err.contains("mw_"), "{err}");
        assert!(keychain::load_device_pairing_in(&store).is_none());
    }

    #[tokio::test]
    async fn unpair_revokes_with_the_key_itself_then_forgets() {
        let api = FakeApi::start_many(|_m, _p, _b| {
            "HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".to_string()
        })
        .await;
        let store = MemStore::default();
        keychain::save_device_pairing_in(
            &store,
            "mw_ab12cd34_s3cr3t",
            r#"{"key_id":"k-1","name":"Laptop","device_id":"d-1","paired_at":1000}"#,
        )
        .unwrap();

        let revoked = unpair_with(&store, &http(), &api.base).await.unwrap();
        assert!(revoked);
        let (method, path, _) = &api.calls()[0];
        assert_eq!(method, "DELETE");
        assert_eq!(path, "/api/keys/k-1");
        assert!(
            keychain::load_device_pairing_in(&store).is_none(),
            "forgotten locally"
        );
    }

    #[tokio::test]
    async fn unpair_forgets_even_when_the_platform_is_unreachable() {
        // Port 1 on loopback: nothing listens, the revoke cannot go out.
        let store = MemStore::default();
        keychain::save_device_pairing_in(
            &store,
            "mw_ab12cd34_s3cr3t",
            r#"{"key_id":"k-1","name":null,"device_id":"d-1","paired_at":1000}"#,
        )
        .unwrap();
        let revoked = unpair_with(&store, &http(), "http://127.0.0.1:1")
            .await
            .unwrap();
        assert!(!revoked);
        assert!(
            keychain::load_device_pairing_in(&store).is_none(),
            "forgotten anyway"
        );
    }

    #[tokio::test]
    async fn unpair_with_nothing_stored_is_a_quiet_no() {
        let store = MemStore::default();
        let revoked = unpair_with(&store, &http(), "http://127.0.0.1:1")
            .await
            .unwrap();
        assert!(!revoked);
    }
}
