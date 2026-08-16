# iroh-spike

Connectivity spike: can a phone browser on cellular reach a desktop behind a
residential NAT via [iroh](https://github.com/n0-computer/iroh), with zero
network configuration?

- `src/bin/spike-server.rs` — native echo server (runs on the desktop behind NAT)
- `src/node.rs` — shared protocol (ALPN `iroh-spike/echo/0`): client sends a
  UTF-8 message, server replies with the echo + its view of the peer id + a
  server timestamp
- `src/wasm.rs` — wasm-bindgen bindings for the browser client
- `docs/` — static test page, published to GitHub Pages

Browser connections are always relayed over WebSocket via n0's public relays
(end-to-end encrypted); that is the condition under test.

## Build

```
# server
cargo build --release --features cli
./target/release/spike-server

# browser client
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.122
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/iroh_spike.wasm \
  --out-dir docs/wasm --weak-refs --target web
```

Open the Pages URL with `?node=<endpoint-id printed by the server>`.

Adapted from n0-computer/iroh-examples `browser-echo` (Apache-2.0/MIT).
