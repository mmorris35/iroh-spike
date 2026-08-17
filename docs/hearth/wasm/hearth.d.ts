/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class HearthClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    endpoint_id(): string;
    /**
     * Fetch the last `limit` transcript turns from the desktop, oldest
     * first. Resolves to `{turns: [{role, text}, …], warning}`. Used on page
     * load so the client renders the desktop's authoritative transcript
     * instead of whatever this browser last saw — and, because every load
     * makes this call, it is where the version handshake rides.
     */
    history(server_id: string, limit: number, client_version?: string | null): Promise<any>;
    /**
     * Present a pairing code (typed by the user, read off the desktop's
     * screen) to the desktop. Resolves on success — including "already
     * paired" — and rejects with the desktop's stated reason otherwise.
     *
     * `code` is passed through as typed; the desktop normalises it
     * (uppercase, separators stripped), so there is exactly one place that
     * decides what a code means.
     */
    pair(server_id: string, code: string, name: string, client_version?: string | null): Promise<void>;
    /**
     * The device secret to persist (hex). Never leaves the browser.
     */
    secret_hex(): string;
    /**
     * Send one message to the desktop identified by `server_id`.
     * Returns a ReadableStream of progress events (see module docs).
     */
    send(server_id: string, message: string, client_version?: string | null): ReadableStream;
    /**
     * Spawn with this device's stable key. `secret_hex` is the persisted
     * device secret (from a previous `secret_hex()` call, kept by the page
     * in localStorage); pass `None`/an unparseable value and a fresh key is
     * minted — which is a fresh, unpaired device identity. The caller MUST
     * read back `secret_hex()` and persist it, or pairing will not survive
     * a reload (losing browser storage losing the pairing is the documented
     * recovery story: re-scan a QR).
     */
    static spawn(secret_hex?: string | null): Promise<HearthClient>;
    /**
     * The client version this wasm module was built with. The page reports
     * its *own* version on the wire (the shell is what goes stale), but
     * exposing this lets the page notice a shell/wasm mismatch.
     */
    static wasmVersion(): string;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_hearthclient_free: (a: number, b: number) => void;
    readonly hearthclient_endpoint_id: (a: number, b: number) => void;
    readonly hearthclient_history: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly hearthclient_pair: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly hearthclient_secret_hex: (a: number, b: number) => void;
    readonly hearthclient_send: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly hearthclient_spawn: (a: number, b: number) => number;
    readonly hearthclient_wasmVersion: (a: number) => void;
    readonly start: () => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wasm_bindgen_func_elem_14735: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_14747: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_5774: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2490: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_7418: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5554: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6694: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6730: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_14605: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
