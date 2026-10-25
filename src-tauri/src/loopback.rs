//! The loopback redirect (RFC 8252 section 7.3), for when the deep link is not
//! registered: a dev build on macOS, a Linux desktop without the `.desktop`
//! entry. One request, on 127.0.0.1 only, on a port the OS picks.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const CALLBACK_PATH: &str = "/callback";

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>MatterWave</title>\
<p>Signed in. You can close this tab and return to MatterWave.</p>";

pub async fn bind() -> std::io::Result<(TcpListener, String)> {
    // 127.0.0.1, never 0.0.0.0: the code must not be reachable from the LAN.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((listener, format!("http://127.0.0.1:{port}{CALLBACK_PATH}")))
}

/// Serve requests until one hits the callback path, and return its full URL.
/// Anything else (a favicon fetch) gets a 404 and the wait continues.
pub async fn accept_callback(listener: TcpListener, redirect_uri: &str) -> std::io::Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await?;
        let head = String::from_utf8_lossy(&buf[..n]);
        match request_target(&head) {
            Some(target) if target.split('?').next() == Some(CALLBACK_PATH) => {
                let page = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{DONE_PAGE}",
                    DONE_PAGE.len()
                );
                let _ = sock.write_all(page.as_bytes()).await;
                let origin = redirect_uri.trim_end_matches(CALLBACK_PATH);
                return Ok(format!("{origin}{target}"));
            }
            _ => {
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        }
    }
}

/// The path and query of a GET request line, or None for anything else.
fn request_target(head: &str) -> Option<&str> {
    let mut parts = head.lines().next()?.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) if target.starts_with('/') => Some(target),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_target_of_a_get() {
        assert_eq!(
            request_target("GET /callback?code=1&state=2 HTTP/1.1\r\nHost: x\r\n"),
            Some("/callback?code=1&state=2")
        );
        assert_eq!(request_target("POST /callback HTTP/1.1\r\n"), None);
        assert_eq!(request_target("GET http://evil/ HTTP/1.1\r\n"), None);
        assert_eq!(request_target(""), None);
    }
}
