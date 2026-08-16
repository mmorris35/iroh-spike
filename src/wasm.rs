use anyhow::{Context, Result};
use n0_future::{Stream, StreamExt};
use serde::Serialize;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

use crate::node;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();

    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::DEBUG)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .init();

    tracing::info!("iroh-spike wasm loaded");
}

#[wasm_bindgen]
pub struct SpikeNode(node::SpikeNode);

#[wasm_bindgen]
impl SpikeNode {
    pub async fn spawn() -> Result<Self, JsError> {
        Ok(Self(node::SpikeNode::spawn(None).await.map_err(to_js_err)?))
    }

    pub fn endpoint_id(&self) -> String {
        self.0.endpoint().id().to_string()
    }

    pub fn connect(
        &self,
        endpoint_id: String,
        payload: String,
    ) -> Result<JsReadableStream, JsError> {
        let endpoint_id = endpoint_id
            .trim()
            .parse()
            .context("failed to parse endpoint id")
            .map_err(to_js_err)?;
        let stream = self.0.connect(endpoint_id, payload);
        Ok(into_js_readable_stream(stream))
    }
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&format!("{err:#}"))
}

fn into_js_readable_stream<T: Serialize>(
    stream: impl Stream<Item = T> + 'static,
) -> JsReadableStream {
    let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
    ReadableStream::from_stream(stream).into_raw()
}
