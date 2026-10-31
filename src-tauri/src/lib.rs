//! The native side of the desktop app: sign-in, the keychain, and the IPC
//! commands the bundled SPA calls. Everything else is the web app.
//!
//! The SPA never sees the refresh token. It asks `get_access_token` for the
//! current access token and sends it as a bearer; refreshing, storing and
//! revoking happen here. An API key (api_key.rs), when the person stores
//! one, stands in for that whole story and is handed out instead.

mod api_key;
mod device_pairing;
mod keychain;
mod loopback;
mod oidc;
mod pkce;
mod tokens;
mod updater;

use oidc::{NativeClient, RefreshError};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokens::TokenSet;
use tokio::sync::{oneshot, Mutex, MutexGuard};

/// Set at build time per environment (README, "Building"). No default: an
/// installer that silently talked to some other environment is worse than
/// one that says it was built without a base.
const BASE_URL: Option<&str> = option_env!("MW_DESKTOP_BASE_URL");

const DEEP_LINK_SCHEME: &str = "matterwave";
const DEEP_LINK_CALLBACK: &str = "matterwave://auth/callback";

/// Long enough to create an account or recover a passkey in the browser;
/// short enough that a forgotten tab does not hold a listener open all day.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Default)]
struct Session {
    /// Whether the keychain has been read; it is read once, lazily, so a
    /// keychain prompt (macOS) appears when the SPA first asks, not at launch.
    loaded: bool,
    tokens: Option<TokenSet>,
    /// The API key, when one is stored. It wins over `tokens`: the person
    /// who pasted a key asked for the machine to act as the key.
    api_key: Option<String>,
}

struct AppState {
    http: reqwest::Client,
    client: Mutex<Option<NativeClient>>,
    /// Held across a refresh, which is what makes concurrent callers wait for
    /// one refresh instead of each spending the (possibly rotating) token.
    session: Mutex<Session>,
    /// The sign-in waiting for its deep-link callback, if any.
    pending: std::sync::Mutex<Option<oneshot::Sender<String>>>,
}

fn base_url() -> Result<&'static str, String> {
    BASE_URL.ok_or_else(|| "this build has no MW_DESKTOP_BASE_URL".to_string())
}

/// The keychain read once, lazily, behind the session lock: every command
/// that needs the stored secrets starts here.
async fn loaded_session(state: &AppState) -> Result<MutexGuard<'_, Session>, String> {
    let mut session = state.session.lock().await;
    if !session.loaded {
        session.tokens = keychain::load();
        session.api_key = keychain::load_api_key();
        session.loaded = true;
    }
    Ok(session)
}

/// The native client, discovered once per run and cached.
async fn native_client(state: &AppState) -> Result<NativeClient, String> {
    let mut cached = state.client.lock().await;
    if let Some(c) = cached.as_ref() {
        return Ok(c.clone());
    }
    let c = oidc::discover(&state.http, base_url()?).await?;
    *cached = Some(c.clone());
    Ok(c)
}

#[derive(Serialize)]
struct AccessToken {
    access_token: String,
    expires_at: u64,
}

/// What an API key reports as its expiry: never. The SPA's refresh timer
/// clamps the wait either way, and `should_refresh` is never consulted on
/// this path -- the key has no grant to refresh with.
const API_KEY_EXPIRES_AT: u64 = u64::MAX;

/// The access token to send, refreshed first when it is close to expiry or
/// when `force` says the API just refused it. `None` means signed out. A
/// stored API key replaces the whole OIDC story and is sent instead.
#[tauri::command]
async fn get_access_token(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<Option<AccessToken>, String> {
    let mut session = loaded_session(&state).await?;
    if let Some(key) = session.api_key.clone() {
        return Ok(Some(AccessToken {
            access_token: key,
            expires_at: API_KEY_EXPIRES_AT,
        }));
    }
    let Some(current) = session.tokens.clone() else {
        return Ok(None);
    };
    let mut set = current;
    if tokens::should_refresh(&set, now(), force.unwrap_or(false)) {
        let refreshed = match native_client(&state).await {
            Ok(client) => {
                oidc::refresh(
                    &state.http,
                    &client,
                    set.refresh_token.as_deref().unwrap_or_default(),
                )
                .await
            }
            Err(e) => Err(RefreshError::Transient(e)),
        };
        match refreshed {
            Ok(new) => {
                keychain::save(&new)?;
                session.tokens = Some(new.clone());
                set = new;
            }
            // A revoked device (Settings -> Sessions) lands here: the next
            // refresh fails and the person is signed out on this machine.
            Err(RefreshError::Rejected(_)) => {
                keychain::clear();
                session.tokens = None;
                return Ok(None);
            }
            // Offline or the IdP is down: a still-valid token is still good.
            Err(RefreshError::Transient(e)) if tokens::is_expired(&set, now()) => return Err(e),
            Err(RefreshError::Transient(_)) => {}
        }
    }
    if set.access_token.is_empty() {
        return Ok(None);
    }
    Ok(Some(AccessToken {
        access_token: set.access_token,
        expires_at: set.expires_at,
    }))
}

/// Whether `matterwave://` reaches this process. When it does not, sign-in
/// uses the loopback redirect instead.
fn deep_link_ready(app: &AppHandle) -> bool {
    #[cfg(any(windows, target_os = "linux"))]
    {
        app.deep_link()
            .is_registered(DEEP_LINK_SCHEME)
            .unwrap_or(false)
    }
    // macOS registers the scheme from the bundle's Info.plist, so only an
    // installed (release) app has it.
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = app;
        !cfg!(debug_assertions)
    }
}

/// Where one sign-in's callback arrives: the redirect URI registered for it,
/// the channel its URL is delivered on, and the loopback listener when the
/// deep link is not the way in.
struct Callback {
    redirect_uri: String,
    rx: oneshot::Receiver<String>,
    loopback_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// The deep link: `route_deep_link` delivers the URL. Replacing an older
/// sender cancels that sign-in, which is right: only the newest browser
/// tab's state can match.
fn deep_link_callback(state: &AppState) -> Result<Callback, String> {
    let (tx, rx) = oneshot::channel::<String>();
    *state.pending.lock().map_err(|e| e.to_string())? = Some(tx);
    Ok(Callback {
        redirect_uri: DEEP_LINK_CALLBACK.to_string(),
        rx,
        loopback_task: None,
    })
}

/// The loopback listener (loopback.rs): one request on a port the OS picks.
async fn loopback_callback() -> Result<Callback, String> {
    let (tx, rx) = oneshot::channel::<String>();
    let (listener, uri) = loopback::bind()
        .await
        .map_err(|e| format!("loopback: {e}"))?;
    let uri_for_task = uri.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Ok(url) = loopback::accept_callback(listener, &uri_for_task).await {
            let _ = tx.send(url);
        }
    });
    Ok(Callback {
        redirect_uri: uri,
        rx,
        loopback_task: Some(task),
    })
}

/// The authorization-code flow between "the client is known" and "the tokens
/// are held": PKCE, the browser, the callback, the exchange. No window and
/// no keychain in here, so a test can run the whole thing against a fake
/// issuer with a closure standing in for the browser.
async fn run_code_flow(
    http: &reqwest::Client,
    client: &NativeClient,
    callback: Callback,
    timeout: Duration,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<TokenSet, String> {
    let verifier = pkce::verifier();
    let expected_state = pkce::state();
    let url = pkce::authorize_url(&pkce::AuthorizeRequest {
        endpoint: &client.authorization_endpoint,
        client_id: &client.client_id,
        redirect_uri: &callback.redirect_uri,
        scopes: &client.scopes,
        challenge: &pkce::challenge(&verifier),
        state: &expected_state,
    })?;
    open_browser(url.as_str())?;

    let waited = tokio::time::timeout(timeout, callback.rx).await;
    if let Some(task) = callback.loopback_task {
        task.abort();
    }
    let raw = waited
        .map_err(|_| "sign-in timed out".to_string())?
        .map_err(|_| "sign-in was replaced by a newer one".to_string())?;
    let code = pkce::parse_callback(&raw, &callback.redirect_uri, &expected_state)
        .map_err(|e| format!("sign-in callback: {e:?}"))?;
    oidc::exchange_code(http, client, &code, &verifier, &callback.redirect_uri).await
}

/// PKCE in the system browser, never an embedded page: password managers
/// and passkeys live in the browser.
#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let client = native_client(&state).await?;
    let callback = if deep_link_ready(&app) {
        deep_link_callback(&state)?
    } else {
        loopback_callback().await?
    };
    let set = run_code_flow(&state.http, &client, callback, SIGN_IN_TIMEOUT, |url| {
        open::that_detached(url).map_err(|e| format!("could not open the browser: {e}"))
    })
    .await?;
    keychain::save(&set)?;
    // A completed browser sign-in supersedes a pasted key: the person just
    // showed they can sign in the ordinary way, and a key left winning here
    // would make the fresh session invisible.
    keychain::clear_api_key();
    *state.session.lock().await = Session {
        loaded: true,
        tokens: Some(set),
        api_key: None,
    };
    focus_main(&app);
    Ok(())
}

/// Revoke at the IdP (best effort), then forget locally whatever happened.
/// The API key goes too: Sign out is "no identity on this machine", not
/// "switch method" -- the settings screen's Remove is the way to keep the
/// browser session and drop only the key.
#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state.session.lock().await;
    keychain::clear_api_key();
    session.api_key = None;
    let tokens = session.tokens.take().or_else(|| {
        if session.loaded {
            None
        } else {
            keychain::load()
        }
    });
    keychain::clear();
    *session = Session {
        loaded: true,
        tokens: None,
        api_key: None,
    };
    drop(session);
    if let (Some(set), Ok(client)) = (tokens, native_client(&state).await) {
        if let Some(r) = &set.refresh_token {
            oidc::revoke(&state.http, &client, r, "refresh_token").await;
        }
        if !set.access_token.is_empty() {
            oidc::revoke(&state.http, &client, &set.access_token, "access_token").await;
        }
    }
    Ok(())
}

/// What the settings screen may show of a stored API key: that there is
/// one, and its id half. The secret never leaves the keychain again.
#[derive(Serialize)]
struct ApiKeyState {
    configured: bool,
    hint: Option<String>,
}

fn api_key_state_of(key: &str) -> ApiKeyState {
    ApiKeyState {
        configured: true,
        hint: Some(api_key::hint(key)),
    }
}

/// Store a pasted API key (Settings -> Account, desktop only) and make it
/// this machine's credential. Validated before it reaches the keychain;
/// the answer is the new state, so the UI can show the hint without a
/// second round trip.
#[tauri::command]
async fn set_api_key(state: State<'_, AppState>, key: String) -> Result<ApiKeyState, String> {
    let trimmed = key.trim().to_string();
    api_key::validate(&trimmed)?;
    keychain::save_api_key(&trimmed)?;
    let mut session = loaded_session(&state).await?;
    session.api_key = Some(trimmed.clone());
    Ok(api_key_state_of(&trimmed))
}

/// Forget the API key, keeping any OIDC session: removing the key falls
/// back to the browser sign-in, which is why it does not clear the tokens
/// the way `sign_out` does.
#[tauri::command]
async fn clear_api_key(state: State<'_, AppState>) -> Result<(), String> {
    keychain::clear_api_key();
    let mut session = loaded_session(&state).await?;
    session.api_key = None;
    Ok(())
}

/// Whether an API key is in use, for the settings screen's sign-in section.
#[tauri::command]
async fn api_key_state(state: State<'_, AppState>) -> Result<ApiKeyState, String> {
    let session = loaded_session(&state).await?;
    Ok(match session.api_key.as_deref() {
        Some(key) => api_key_state_of(key),
        None => ApiKeyState {
            configured: false,
            hint: None,
        },
    })
}

/// What the Devices pane shows of the machine's own pairing: that it is
/// paired, as what, and the key's hint. The secret stays in the keychain
/// and is never the app's bearer -- the device key may only add
/// conversations (device_pairing.rs).
#[derive(Serialize)]
struct DevicePairingState {
    paired: bool,
    name: Option<String>,
    hint: Option<String>,
    device_id: Option<String>,
    /// Unix seconds.
    paired_at: Option<u64>,
}

const UNPAIRED_DEVICE: DevicePairingState = DevicePairingState {
    paired: false,
    name: None,
    hint: None,
    device_id: None,
    paired_at: None,
};

fn device_state_of(meta: device_pairing::PairingMeta, hint: Option<String>) -> DevicePairingState {
    DevicePairingState {
        paired: true,
        name: meta.name,
        hint,
        device_id: Some(meta.device_id),
        paired_at: Some(meta.paired_at),
    }
}

/// Redeem a pairing code (Settings -> Devices on the platform makes one)
/// and keep the device key in the keychain.
#[tauri::command]
async fn pair_device(
    state: State<'_, AppState>,
    code: String,
) -> Result<DevicePairingState, String> {
    let meta = device_pairing::pair(&state.http, base_url()?, &code).await?;
    let hint = keychain::load_device_pairing().map(|(key, _)| api_key::hint(&key));
    Ok(device_state_of(meta, hint))
}

/// The pairing as the pane renders it.
#[tauri::command]
fn device_pairing_state() -> DevicePairingState {
    match device_pairing::load_meta() {
        Some(meta) => {
            let hint = keychain::load_device_pairing().map(|(key, _)| api_key::hint(&key));
            device_state_of(meta, hint)
        }
        None => UNPAIRED_DEVICE,
    }
}

/// Revoke the device key on the platform (best effort) and forget the
/// pairing. The answer is the state after, so the pane swaps in one step.
#[tauri::command]
async fn unpair_device(state: State<'_, AppState>) -> Result<DevicePairingState, String> {
    device_pairing::unpair(&state.http, base_url()?).await?;
    Ok(UNPAIRED_DEVICE)
}

/// Links out of the app go to the system browser. Only web and mail links:
/// the webview must not be able to launch arbitrary handlers (`file:`,
/// custom schemes) through this command.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err(format!("refusing to open a {} link", parsed.scheme()));
    }
    open::that_detached(parsed.as_str()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct AppInfo {
    /// The same string as the API's MW_RELEASE for a release build, so a
    /// support thread can match the two.
    version: String,
    api_base_url: Option<&'static str>,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        api_base_url: BASE_URL,
    }
}

/// The OS notification for a finished answer: the one signal that reaches
/// somebody in another window while the model streams. Shown only when the
/// main window is not focused -- a focused window already shows the reply
/// land. `title` and `body` are the SPA's fixed copy; reply text never goes
/// into a notification.
#[tauri::command]
fn notify_generation_complete(app: AppHandle, title: String, body: String) -> Result<bool, String> {
    let focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(true);
    if focused {
        return Ok(false);
    }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// The SPA's "check for updates": one check, the newer version as the answer
/// and as `update-available` for listeners (updater.rs). Reporting only:
/// nothing downloads or installs. A build without MW_DESKTOP_UPDATER has no
/// plugin to ask, and it answers cleanly -- "no update" -- because updates
/// being switched off is not a failure to surface.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    if !updater::enabled() {
        return Ok(None);
    }
    updater::check(&app).await
}

/// What the last completed check found, for a banner that mounted after the
/// launch check had already run: the event alone would be missed.
#[tauri::command]
fn pending_update() -> Option<String> {
    updater::pending()
}

/// Download the offered update, verify it (the release job's key), hand it
/// to the OS installer and relaunch. Progress reaches the SPA as
/// `update-download-progress` / `update-download-finished` events. A build
/// made without MW_DESKTOP_UPDATER has no updater at all, so the answer is
/// the plain fact rather than an error to surface.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if !updater::enabled() {
        return Err("updates are disabled in this build".into());
    }
    updater::download_and_install(&app).await
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The tray's Show/Hide: visible means hide (get the window out of the way
/// without quitting), anything else means show and focus. Focused-but-
/// behind counts as hidden, so the item always does something visible.
#[cfg(desktop)]
fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_focused().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// The system tray: Show/Hide and Quit, nothing else. The menu on left
/// click too, because the tray item is not a drop target for anything and
/// a menu that needs a right click is a menu half the world never finds.
#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> Result<(), tauri::Error> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let show_hide =
        MenuItem::with_id(app, "show-hide", "Show/Hide MatterWave", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MatterWave", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &quit])?;
    TrayIconBuilder::with_id("matterwave")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::InvalidIcon(std::io::Error::other(
                "the bundle has no window icon for the tray",
            ))
        })?)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-hide" => toggle_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn route_deep_link(app: &AppHandle, url: &str) {
    if url.starts_with(DEEP_LINK_CALLBACK) {
        let sender = app
            .state::<AppState>()
            .pending
            .lock()
            .ok()
            .and_then(|mut p| p.take());
        if let Some(tx) = sender {
            let _ = tx.send(url.to_string());
        }
    } else {
        // Conversation links and the like belong to the SPA's router.
        let _ = app.emit("deep-link", url.to_string());
    }
    focus_main(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        http: reqwest::Client::builder()
            .user_agent(concat!("MatterWave-Desktop/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client"),
        client: Mutex::new(None),
        session: Mutex::new(Session::default()),
        pending: std::sync::Mutex::new(None),
    };

    let mut builder = tauri::Builder::default()
        // First, per the plugin's docs: a second launch (including the one a
        // deep link starts on Windows and Linux) is folded into this one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // Size and position persist: saved when the window closes, restored
        // at launch, with the config's numbers as the first-run default.
        .plugin(tauri_plugin_window_state::Builder::default().build());
    // Only a build that asked for updates carries the plugin (updater.rs).
    if updater::enabled() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(state)
        .setup(|app| {
            // Windows and Linux can register the scheme at runtime, which is
            // what makes the deep link work in dev and from an AppImage.
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    route_deep_link(&handle, url.as_str());
                }
            });
            if updater::enabled() {
                updater::check_on_launch(app.handle().clone());
            }
            // The tray ships whatever the updater does: it is part of the
            // app, not of a build flag.
            #[cfg(desktop)]
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_access_token,
            sign_in,
            sign_out,
            open_external,
            app_info,
            check_for_updates,
            notify_generation_complete,
            install_update,
            pending_update,
            set_api_key,
            clear_api_key,
            api_key_state,
            pair_device,
            device_pairing_state,
            unpair_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running the MatterWave desktop app");
}

/// The sign-in flow against a fake issuer: discovery through
/// `/api/auth-config`, the authorize URL handed to a stand-in browser, the
/// loopback callback, and the token exchange checked for the PKCE verifier
/// the challenge was made from. No window, no keychain, no network beyond
/// 127.0.0.1.
#[cfg(test)]
mod sign_in_tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const CLIENT_ID: &str = "native-1";
    const CODE: &str = "c-1";

    /// A one-listener issuer-and-API. GET /api/auth-config names the native
    /// client and this server's own endpoints; POST /oauth/v2/token redeems
    /// the code only for the verifier whose challenge the authorize URL
    /// carried; POST /oauth/v2/revoke records the call.
    #[derive(Default)]
    struct FakeIssuer {
        base: String,
        /// The authorize request the stand-in browser saw, by query name.
        authorize: Mutex<Option<HashMap<String, String>>>,
        /// Every token-endpoint form, in order.
        token_forms: Mutex<Vec<HashMap<String, String>>>,
        revoked: Mutex<Vec<String>>,
    }

    impl FakeIssuer {
        async fn start() -> Arc<Self> {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let issuer = Arc::new(Self {
                base,
                ..Self::default()
            });
            let serving = issuer.clone();
            tokio::spawn(async move {
                while let Ok((sock, _)) = listener.accept().await {
                    let issuer = serving.clone();
                    tokio::spawn(async move { issuer.serve(sock).await });
                }
            });
            issuer
        }

        async fn serve(&self, mut sock: tokio::net::TcpStream) {
            let (head, body) = read_request(&mut sock).await;
            let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
            let (method, target) = (
                parts.next().unwrap_or_default(),
                parts.next().unwrap_or_default(),
            );
            let response = match (method, target) {
                ("GET", "/api/auth-config") => json(200, &self.auth_config()),
                ("POST", "/oauth/v2/token") => self.token(form(&body)),
                ("POST", "/oauth/v2/revoke") => {
                    self.revoked
                        .lock()
                        .unwrap()
                        .push(form(&body).remove("token").unwrap_or_default());
                    text(200, "")
                }
                _ => text(404, "no such route"),
            };
            let _ = sock.write_all(response.as_bytes()).await;
            let _ = sock.shutdown().await;
        }

        fn auth_config(&self) -> String {
            format!(
                r#"{{"auth_mode":"oidc","client_id":"web-1","native_client_id":"{CLIENT_ID}","authorization_endpoint":"{0}/oauth/v2/authorize","token_endpoint":"{0}/oauth/v2/token","scopes":["openid","profile"]}}"#,
                self.base
            )
        }

        fn token(&self, form: HashMap<String, String>) -> String {
            self.token_forms.lock().unwrap().push(form.clone());
            let get = |k: &str| form.get(k).cloned().unwrap_or_default();
            let accepted = match get("grant_type").as_str() {
                "authorization_code" => {
                    let authorize = self.authorize.lock().unwrap().clone().unwrap_or_default();
                    get("client_id") == CLIENT_ID
                        && get("code") == CODE
                        && get("redirect_uri")
                            == authorize.get("redirect_uri").cloned().unwrap_or_default()
                        && pkce::challenge(&get("code_verifier"))
                            == authorize.get("code_challenge").cloned().unwrap_or_default()
                }
                "refresh_token" => get("client_id") == CLIENT_ID && get("refresh_token") == "rt-1",
                _ => false,
            };
            if accepted {
                json(
                    200,
                    r#"{"access_token":"at-1","token_type":"Bearer","expires_in":3600,"refresh_token":"rt-1"}"#,
                )
            } else {
                json(
                    400,
                    r#"{"error":"invalid_grant","error_description":"not the code this issuer handed out"}"#,
                )
            }
        }

        /// The stand-in browser: records the authorize request and sends the
        /// callback the IdP would, with `query` appended to the redirect URI.
        fn browser(
            self: &Arc<Self>,
            query: impl Fn(&HashMap<String, String>) -> String + Send + 'static,
        ) -> impl FnOnce(&str) -> Result<(), String> {
            let issuer = self.clone();
            move |url: &str| {
                let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
                let q: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
                let callback = format!("{}?{}", q["redirect_uri"], query(&q));
                *issuer.authorize.lock().unwrap() = Some(q);
                tokio::spawn(async move {
                    let _ = reqwest::get(callback).await;
                });
                Ok(())
            }
        }
    }

    async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, String) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                return (String::from_utf8_lossy(&buf).into_owned(), String::new());
            }
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
                return (
                    head,
                    String::from_utf8_lossy(&buf[body_start..]).into_owned(),
                );
            }
        }
    }

    fn form(body: &str) -> HashMap<String, String> {
        url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect()
    }

    fn respond(status: u16, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn json(status: u16, body: &str) -> String {
        respond(status, "application/json", body)
    }

    fn text(status: u16, body: &str) -> String {
        respond(status, "text/plain", body)
    }

    fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn discovery_reads_the_native_client_from_auth_config() {
        let issuer = FakeIssuer::start().await;
        let client = oidc::discover(&http(), &issuer.base).await.unwrap();
        assert_eq!(client.client_id, CLIENT_ID);
        assert_eq!(
            client.token_endpoint,
            format!("{}/oauth/v2/token", issuer.base)
        );
        assert_eq!(
            client.revocation_endpoint.as_deref(),
            Some(format!("{}/oauth/v2/revoke", issuer.base).as_str())
        );
        assert!(client.scopes.iter().any(|s| s == "offline_access"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_loopback_flow_ends_with_tokens_for_the_pkce_verifier() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();
        let callback = loopback_callback().await.unwrap();
        assert!(
            callback.redirect_uri.starts_with("http://127.0.0.1:"),
            "{}",
            callback.redirect_uri
        );
        assert!(callback.redirect_uri.ends_with(loopback::CALLBACK_PATH));

        let browser = issuer.browser(|q| format!("code={CODE}&state={}", q["state"]));
        let set = run_code_flow(&http, &client, callback, Duration::from_secs(5), browser)
            .await
            .unwrap();

        assert_eq!(set.access_token, "at-1");
        assert_eq!(set.refresh_token.as_deref(), Some("rt-1"));
        assert!(set.expires_at > now() + 3000);
        let authorize = issuer.authorize.lock().unwrap().clone().unwrap();
        assert_eq!(authorize["client_id"], CLIENT_ID);
        assert_eq!(authorize["code_challenge_method"], "S256");
        assert!(authorize["scope"].split(' ').any(|s| s == "offline_access"));
        let forms = issuer.token_forms.lock().unwrap();
        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0]["grant_type"], "authorization_code");
        assert_eq!(forms[0]["redirect_uri"], authorize["redirect_uri"]);
        assert!(
            !forms[0].contains_key("client_secret"),
            "a native client has no secret to send"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_callback_with_another_state_never_reaches_the_token_endpoint() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();
        let callback = loopback_callback().await.unwrap();

        let browser = issuer.browser(|_| format!("code={CODE}&state=someone-elses"));
        let err = run_code_flow(&http, &client, callback, Duration::from_secs(5), browser)
            .await
            .unwrap_err();

        assert!(err.contains("StateMismatch"), "{err}");
        assert!(issuer.token_forms.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_sign_in_reports_the_idp_error() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();
        let callback = loopback_callback().await.unwrap();

        let browser = issuer.browser(|q| format!("error=access_denied&state={}", q["state"]));
        let err = run_code_flow(&http, &client, callback, Duration::from_secs(5), browser)
            .await
            .unwrap_err();

        assert!(err.contains("access_denied"), "{err}");
        assert!(issuer.token_forms.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_browser_that_never_comes_back_times_out_and_frees_the_port() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();
        let callback = loopback_callback().await.unwrap();
        let redirect_uri = callback.redirect_uri.clone();

        let err = run_code_flow(&http, &client, callback, Duration::from_millis(200), |_| {
            Ok(())
        })
        .await
        .unwrap_err();

        assert_eq!(err, "sign-in timed out");
        // The listener task was aborted with the wait, so nothing answers
        // on that port any more.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(reqwest::get(format!("{redirect_uri}?code=late&state=x"))
            .await
            .is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_browser_that_cannot_open_fails_before_waiting() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();
        let callback = loopback_callback().await.unwrap();

        let err = run_code_flow(&http, &client, callback, Duration::from_secs(5), |_| {
            Err("could not open the browser: no handler".into())
        })
        .await
        .unwrap_err();

        assert!(err.contains("could not open the browser"));
        assert!(issuer.authorize.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refresh_is_redeemed_and_a_dead_grant_is_rejected() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();

        let set = oidc::refresh(&http, &client, "rt-1").await.unwrap();
        assert_eq!(set.access_token, "at-1");

        let dead = oidc::refresh(&http, &client, "rt-revoked")
            .await
            .unwrap_err();
        assert!(
            matches!(dead, RefreshError::Rejected(ref m) if m.starts_with("invalid_grant")),
            "{dead:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revoke_posts_the_token_to_the_sibling_endpoint() {
        let issuer = FakeIssuer::start().await;
        let http = http();
        let client = oidc::discover(&http, &issuer.base).await.unwrap();

        oidc::revoke(&http, &client, "rt-1", "refresh_token").await;
        assert_eq!(*issuer.revoked.lock().unwrap(), vec!["rt-1".to_string()]);
    }
}
