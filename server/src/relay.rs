//! Relay mode: hide the home IP and skip router port forwarding.
//!
//! The same Llamble image runs on a small VPS the admin rents (`llamble-server relay`).
//! The home server dials OUT to the VPS on the control port and proves it knows the
//! relay token (HMAC challenge-response; the token itself never crosses the wire).
//! Both ends then share one multiplexed connection (yamux). Each visitor connection to
//! the VPS becomes a stream that the home server connects to its own local ports:
//!   VPS :8443/tcp (map 443 to it) -> home :8443  (HTTPS web, app, voice signaling)
//!   VPS :7881/tcp                 -> home :7881  (voice over TCP fallback)
//!   VPS :7882/udp                 -> home :7882  (voice media, framed over a stream)
//! TLS is end-to-end: the VPS only moves encrypted bytes and has no certificate or keys.
//!
//! There is no shared or central relay. Every install points at its own VPS and token.
use futures::StreamExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio_yamux::{Config as YConfig, Control, Session, StreamHandle};

pub const CONTROL_PORT: u16 = 7900;
const MAGIC: &[u8; 8] = b"LLAMBLE1";

const KIND_HTTPS: u8 = 1;
const KIND_RTC_TCP: u8 = 2;
const KIND_RTC_UDP: u8 = 3;

fn local_port(kind: u8) -> Option<u16> {
    match kind {
        KIND_HTTPS => Some(crate::remote::HTTPS_PORT),
        KIND_RTC_TCP => Some(crate::voice_server::TCP_PORT),
        KIND_RTC_UDP => Some(crate::voice_server::UDP_PORT),
        _ => None,
    }
}

fn proof(token: &str, nonce: &[u8]) -> [u8; 32] {
    let mut m = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("hmac key");
    m.update(b"llamble-relay");
    m.update(nonce);
    m.finalize().into_bytes().into()
}

fn yconfig() -> YConfig {
    let mut c = YConfig::default();
    c.max_stream_window_size = 4 * 1024 * 1024;
    c
}

// ---------- UDP framing over a stream: [u16 len][payload] ----------

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> std::io::Result<()> {
    let len = u16::try_from(data.len()).map_err(|_| std::io::Error::other("datagram too big"))?;
    let mut buf = Vec::with_capacity(2 + data.len());
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(data);
    w.write_all(&buf).await?;
    w.flush().await
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> std::io::Result<()> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len).await?;
    let n = u16::from_be_bytes(len) as usize;
    buf.resize(n, 0);
    r.read_exact(buf).await?;
    Ok(())
}

// =====================================================================
// VPS side: `llamble-server relay`
// =====================================================================

type Current = Arc<Mutex<Option<(u64, Control)>>>;

pub async fn run_relay_server() -> anyhow::Result<()> {
    let token = std::env::var("LLAMBLE_RELAY_TOKEN").unwrap_or_default();
    if token.trim().len() < 16 {
        anyhow::bail!("set LLAMBLE_RELAY_TOKEN to the token shown in Llamble → Server → Remote Access");
    }
    let token = token.trim().to_string();
    let current: Current = Arc::new(Mutex::new(None));
    // testing only: shift the public ports so a relay and a home server can share one machine
    let shift: u16 = std::env::var("LLAMBLE_RELAY_PORT_SHIFT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    tracing::info!("Llamble relay: waiting for the home server on :{CONTROL_PORT}");

    // control: the home server connects here
    {
        let current = current.clone();
        let l = TcpListener::bind(("0.0.0.0", CONTROL_PORT)).await?;
        tokio::spawn(async move {
            let mut next_id = 0u64;
            loop {
                let Ok((sock, peer)) = l.accept().await else { continue };
                next_id += 1;
                let (id, token, current) = (next_id, token.clone(), current.clone());
                tokio::spawn(async move {
                    if let Err(e) = handle_home(sock, peer, id, &token, current).await {
                        tracing::warn!("relay: home connection from {peer} ended: {e}");
                    }
                });
            }
        });
    }
    // public TCP ports -> streams
    for (port, kind) in [(crate::remote::HTTPS_PORT, KIND_HTTPS), (crate::voice_server::TCP_PORT, KIND_RTC_TCP)] {
        let l = TcpListener::bind(("0.0.0.0", port + shift)).await?;
        let current = current.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else { continue };
                let current = current.clone();
                tokio::spawn(async move {
                    let ctl = current.lock().await.as_ref().map(|(_, c)| c.clone());
                    let Some(mut ctl) = ctl else { return };
                    let Ok(mut s) = ctl.open_stream().await else { return };
                    if s.write_all(&[kind]).await.is_err() {
                        return;
                    }
                    let _ = sock.set_nodelay(true);
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut s).await;
                });
            }
        });
    }
    // public UDP -> one stream per visitor address
    let udp = Arc::new(UdpSocket::bind(("0.0.0.0", crate::voice_server::UDP_PORT + shift)).await?);
    let mut peers: HashMap<SocketAddr, (mpsc::Sender<Vec<u8>>, Instant)> = HashMap::new();
    let mut buf = vec![0u8; 65535];
    let mut last_sweep = Instant::now();
    tracing::info!("Llamble relay: public ports {} (https), {}/tcp, {}/udp", crate::remote::HTTPS_PORT, crate::voice_server::TCP_PORT, crate::voice_server::UDP_PORT);
    loop {
        let (n, from) = udp.recv_from(&mut buf).await?;
        if last_sweep.elapsed() > Duration::from_secs(30) {
            peers.retain(|_, (tx, seen)| !tx.is_closed() && seen.elapsed() < Duration::from_secs(120));
            last_sweep = Instant::now();
        }
        let pkt = buf[..n].to_vec();
        if let Some((tx, seen)) = peers.get_mut(&from) {
            *seen = Instant::now();
            if tx.try_send(pkt).is_ok() {
                continue;
            }
            peers.remove(&from);
            continue;
        }
        let ctl = current.lock().await.as_ref().map(|(_, c)| c.clone());
        let Some(mut ctl) = ctl else { continue };
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(512);
        let _ = tx.try_send(pkt);
        peers.insert(from, (tx, Instant::now()));
        let udp = udp.clone();
        tokio::spawn(async move {
            let Ok(s) = ctl.open_stream().await else { return };
            let (mut rd, mut wr) = tokio::io::split(s);
            if wr.write_all(&[KIND_RTC_UDP]).await.is_err() {
                return;
            }
            let up = async {
                while let Some(p) = rx.recv().await {
                    if write_frame(&mut wr, &p).await.is_err() {
                        break;
                    }
                }
            };
            let down = async {
                let mut b = Vec::new();
                while read_frame(&mut rd, &mut b).await.is_ok() {
                    let _ = udp.send_to(&b, from).await;
                }
            };
            tokio::select! { _ = up => {}, _ = down => {} }
        });
    }
}

async fn handle_home(mut sock: TcpStream, peer: SocketAddr, id: u64, token: &str, current: Current) -> anyhow::Result<()> {
    use rand::RngCore;
    sock.set_nodelay(true)?;
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    sock.write_all(MAGIC).await?;
    sock.write_all(&nonce).await?;
    let mut magic = [0u8; 8];
    let mut answer = [0u8; 32];
    tokio::time::timeout(Duration::from_secs(10), async {
        sock.read_exact(&mut magic).await?;
        sock.read_exact(&mut answer).await
    })
    .await??;
    let expected = proof(token, &nonce);
    let ok = &magic == MAGIC && constant_eq(&answer, &expected);
    sock.write_all(&[ok as u8]).await?;
    if !ok {
        anyhow::bail!("wrong relay token");
    }
    tracing::info!("relay: home server connected from {peer}");
    let mut session = Session::new_server(sock, yconfig());
    *current.lock().await = Some((id, session.control()));
    // drive the session; the home side never opens streams toward us
    while let Some(r) = session.next().await {
        if r.is_err() {
            break;
        }
    }
    let mut cur = current.lock().await;
    if cur.as_ref().map(|(i, _)| *i) == Some(id) {
        *cur = None;
    }
    tracing::info!("relay: home server disconnected");
    Ok(())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// =====================================================================
// Home side: keep a connection to the VPS while relay mode is on
// =====================================================================

/// Connect to the relay and serve streams until it drops. Returns a readable error.
pub async fn run_home_link(addr: &str, token: &str, on_up: impl FnOnce()) -> Result<(), String> {
    let target = if addr.contains(':') { addr.to_string() } else { format!("{addr}:{CONTROL_PORT}") };
    let mut sock = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(&target))
        .await
        .map_err(|_| format!("timed out reaching {target} (is the relay running and port {CONTROL_PORT} open?)"))?
        .map_err(|e| format!("can't reach {target}: {e}"))?;
    let _ = sock.set_nodelay(true);
    let mut magic = [0u8; 8];
    let mut nonce = [0u8; 32];
    let hs = async {
        sock.read_exact(&mut magic).await?;
        sock.read_exact(&mut nonce).await?;
        Ok::<_, std::io::Error>(())
    };
    tokio::time::timeout(Duration::from_secs(10), hs).await.map_err(|_| "relay didn't answer".to_string())?.map_err(|e| e.to_string())?;
    if &magic != MAGIC {
        return Err(format!("{target} isn't a Llamble relay"));
    }
    sock.write_all(MAGIC).await.map_err(|e| e.to_string())?;
    sock.write_all(&proof(token, &nonce)).await.map_err(|e| e.to_string())?;
    let mut ok = [0u8; 1];
    sock.read_exact(&mut ok).await.map_err(|e| e.to_string())?;
    if ok[0] != 1 {
        return Err("the relay rejected the token — copy the command from Remote Access again".into());
    }
    on_up();
    let mut session = Session::new_client(sock, yconfig());
    while let Some(next) = session.next().await {
        match next {
            Ok(s) => {
                tokio::spawn(serve_stream(s));
            }
            Err(e) => return Err(format!("relay connection lost: {e}")),
        }
    }
    Err("relay connection closed".into())
}

async fn serve_stream(mut s: StreamHandle) {
    let mut kind = [0u8; 1];
    if s.read_exact(&mut kind).await.is_err() {
        return;
    }
    let Some(port) = local_port(kind[0]) else { return };
    if kind[0] == KIND_RTC_UDP {
        let Ok(sock) = UdpSocket::bind("127.0.0.1:0").await else { return };
        if sock.connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        let (mut rd, mut wr) = tokio::io::split(s);
        let sock = Arc::new(sock);
        let s1 = sock.clone();
        let up = async move {
            let mut b = Vec::new();
            while read_frame(&mut rd, &mut b).await.is_ok() {
                let _ = s1.send(&b).await;
            }
        };
        let down = async move {
            let mut b = vec![0u8; 65535];
            loop {
                match tokio::time::timeout(Duration::from_secs(180), sock.recv(&mut b)).await {
                    Ok(Ok(n)) => {
                        if write_frame(&mut wr, &b[..n]).await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        };
        tokio::select! { _ = up => {}, _ = down => {} }
        return;
    }
    let Ok(mut local) = TcpStream::connect(("127.0.0.1", port)).await else { return };
    let _ = local.set_nodelay(true);
    let _ = tokio::io::copy_bidirectional(&mut s, &mut local).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_depends_on_token_and_nonce() {
        let a = proof("token-aaaaaaaaaaaaaaaa", b"n1");
        assert_eq!(a, proof("token-aaaaaaaaaaaaaaaa", b"n1"));
        assert_ne!(a, proof("token-bbbbbbbbbbbbbbbb", b"n1"));
        assert_ne!(a, proof("token-aaaaaaaaaaaaaaaa", b"n2"));
        assert!(constant_eq(&a, &a) && !constant_eq(&a, &proof("x", b"n1")));
    }
}
