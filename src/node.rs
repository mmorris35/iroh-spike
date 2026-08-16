use anyhow::Result;
use async_channel::Sender;
use iroh::{
    Endpoint, EndpointId,
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
};
use n0_future::{Stream, StreamExt, boxed::BoxStream, task};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tracing::info;

const MAX_MSG: usize = 64 * 1024;

fn unix_secs() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct SpikeNode {
    router: Router,
    accept_events: broadcast::Sender<AcceptEvent>,
}

impl SpikeNode {
    pub async fn spawn(secret: Option<iroh::SecretKey>) -> Result<Self> {
        let mut builder = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .alpns(vec![Spike::ALPN.to_vec()]);
        if let Some(secret) = secret {
            builder = builder.secret_key(secret);
        }
        let endpoint = builder.bind().await?;
        let (event_sender, _event_receiver) = broadcast::channel(128);
        let spike = Spike::new(event_sender.clone());
        let router = Router::builder(endpoint).accept(Spike::ALPN, spike).spawn();
        Ok(Self {
            router,
            accept_events: event_sender,
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    pub fn accept_events(&self) -> BoxStream<AcceptEvent> {
        let receiver = self.accept_events.subscribe();
        Box::pin(BroadcastStream::new(receiver).filter_map(|event| event.ok()))
    }

    pub fn connect(
        &self,
        endpoint_id: EndpointId,
        payload: String,
    ) -> impl Stream<Item = ConnectEvent> + Unpin + use<> {
        let (event_sender, event_receiver) = async_channel::bounded(16);
        let endpoint = self.router.endpoint().clone();
        task::spawn(async move {
            let res = connect(&endpoint, endpoint_id, payload, event_sender.clone()).await;
            let error = res.as_ref().err().map(|err| format!("{err:#}"));
            event_sender.send(ConnectEvent::Closed { error }).await.ok();
        });
        Box::pin(event_receiver)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectEvent {
    Connected { path: String },
    Sent { bytes_sent: u64 },
    Received { text: String },
    Closed { error: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcceptEvent {
    Accepted {
        endpoint_id: EndpointId,
        path: String,
    },
    Message {
        endpoint_id: EndpointId,
        text: String,
        reply: String,
    },
    Closed {
        endpoint_id: EndpointId,
        error: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct Spike {
    event_sender: broadcast::Sender<AcceptEvent>,
}

impl Spike {
    pub const ALPN: &[u8] = b"iroh-spike/echo/0";
    pub fn new(event_sender: broadcast::Sender<AcceptEvent>) -> Self {
        Self { event_sender }
    }
}

/// Human-readable snapshot of the connection's open network paths
/// (typically a relay path, plus a direct path once holepunching succeeds).
fn conn_path(connection: &Connection) -> String {
    format!("{:?}", connection.paths())
}

impl Spike {
    async fn handle_connection(
        self,
        connection: Connection,
    ) -> std::result::Result<(), AcceptError> {
        let endpoint_id = connection.remote_id();
        let res = self.handle_connection_0(&connection).await;
        let error = res.as_ref().err().map(|err| err.to_string());
        self.event_sender
            .send(AcceptEvent::Closed { endpoint_id, error })
            .ok();
        res
    }

    async fn handle_connection_0(
        &self,
        connection: &Connection,
    ) -> std::result::Result<(), AcceptError> {
        let endpoint_id = connection.remote_id();
        info!("accepted connection from {endpoint_id}");
        self.event_sender
            .send(AcceptEvent::Accepted {
                endpoint_id,
                path: conn_path(connection),
            })
            .ok();

        // Request-response: peer opens one bi stream, sends a UTF-8 message,
        // finishes; we reply with proof-of-round-trip and finish.
        let (mut send, mut recv) = connection.accept_bi().await?;
        let bytes = recv
            .read_to_end(MAX_MSG)
            .await
            .map_err(AcceptError::from_err)?;
        let text = String::from_utf8_lossy(&bytes).to_string();

        let reply = format!(
            "ECHO: {text}\nSEEN-FROM (your endpoint id): {endpoint_id}\nSERVER-TIME (unix): {}\nSERVER: distiller (ARM64 Linux, residential NAT, Sacramento)",
            unix_secs()
        );
        send.write_all(reply.as_bytes())
            .await
            .map_err(AcceptError::from_err)?;
        send.finish()?;

        self.event_sender
            .send(AcceptEvent::Message {
                endpoint_id,
                text,
                reply,
            })
            .ok();

        // Wait until the remote closes the connection after reading the reply.
        connection.closed().await;
        Ok(())
    }
}

impl ProtocolHandler for Spike {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        self.clone().handle_connection(connection).await
    }
}

async fn connect(
    endpoint: &Endpoint,
    endpoint_id: EndpointId,
    payload: String,
    event_sender: Sender<ConnectEvent>,
) -> Result<()> {
    let connection = endpoint.connect(endpoint_id, Spike::ALPN).await?;
    let path = conn_path(&connection);
    event_sender.send(ConnectEvent::Connected { path }).await?;

    let (mut send_stream, mut recv_stream) = connection.open_bi().await?;
    let bytes_sent = payload.len() as u64;
    send_stream.write_all(payload.as_bytes()).await?;
    send_stream.finish()?;
    event_sender.send(ConnectEvent::Sent { bytes_sent }).await?;

    let reply = recv_stream.read_to_end(MAX_MSG).await?;
    let text = String::from_utf8_lossy(&reply).to_string();
    connection.close(1u8.into(), b"done");
    event_sender.send(ConnectEvent::Received { text }).await?;
    Ok(())
}
