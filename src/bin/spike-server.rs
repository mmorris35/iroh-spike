use anyhow::Result;
use iroh_spike::node::{AcceptEvent, SpikeNode};
use n0_future::StreamExt;

const PAGE: &str = "https://mmorris35.github.io/iroh-spike/";

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S %Z").to_string()
}

/// Persist the node's secret key next to the binary's project dir so the
/// endpoint id (and thus the phone URL) survives restarts.
fn load_or_create_secret() -> Result<iroh::SecretKey> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("secret.key");
    if path.exists() {
        let hex = std::fs::read_to_string(&path)?;
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex.trim()[i * 2..i * 2 + 2], 16)?;
        }
        return Ok(iroh::SecretKey::from_bytes(&bytes));
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("getrandom failed: {e:?}"))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(&path, &hex)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(iroh::SecretKey::from_bytes(&bytes))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let node = SpikeNode::spawn(Some(load_or_create_secret()?)).await?;
    let id = node.endpoint().id();
    println!("[{}] iroh-spike server up", now());
    println!("endpoint id: {id}");
    println!("open on phone: {PAGE}?node={id}");
    println!("---");

    let mut events = node.accept_events();
    while let Some(event) = events.next().await {
        match event {
            AcceptEvent::Accepted { endpoint_id, path } => {
                println!("[{}] ACCEPTED conn from {endpoint_id} path={path}", now());
            }
            AcceptEvent::Message {
                endpoint_id, text, ..
            } => {
                println!("[{}] MESSAGE from {endpoint_id}: {text:?} — replied", now());
            }
            AcceptEvent::Closed { endpoint_id, error } => match error {
                Some(e) => println!("[{}] CLOSED {endpoint_id} with error: {e}", now()),
                None => println!("[{}] CLOSED {endpoint_id} cleanly", now()),
            },
        }
    }
    Ok(())
}
