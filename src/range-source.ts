// A byte-range reader over one FlatGeobuf file. The loader only needs `read(start, end)`;
// where the bytes come from (HTTP in a browser or in Node, a local file in Node) is up to the source.

export interface RangeSource {
  /** Bytes [start, end) of the file. Must throw if the file changed since the first read. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** Total file size, known after the first read. */
  readonly size: number;
  /** Requests and bytes so far, for reporting. */
  readonly requests: number;
  readonly bytes: number;
}

export type HttpRangeSourceOptions = {
  /** Extra request headers (authentication, …). */
  headers?: Record<string, string>;
  /** fetch implementation; defaults to the global fetch (browsers, Node ≥ 18). */
  fetch?: typeof fetch;
};

/**
 * Range requests over HTTP(S), with version pinning: every request after the first sends
 * `If-Match: <ETag of the first response>` and the total size in `Content-Range` must not change,
 * so the index and the features always come from the same version of the file.
 * Works in browsers, Web Workers and Node.
 */
export function httpRangeSource(url: string, options: HttpRangeSourceOptions = {}): RangeSource {
  const doFetch = options.fetch ?? fetch;
  let etag: string | null = null;
  const state = { size: -1, requests: 0, bytes: 0 };
  return {
    get size() { return state.size; },
    get requests() { return state.requests; },
    get bytes() { return state.bytes; },
    async read(start, end) {
      const headers: Record<string, string> = { ...options.headers, Range: `bytes=${start}-${end - 1}` };
      if (etag) headers['If-Match'] = etag;
      const res = await doFetch(url, { headers });
      state.requests++;
      if (res.status === 412) throw new Error(`${url} changed while loading (ETag mismatch)`);
      if (res.status !== 206) throw new Error(`${url}: expected 206 Partial Content, got ${res.status} — the server must support HTTP Range requests`);
      const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? NaN);
      if (!Number.isFinite(total)) throw new Error(`${url}: missing total size in Content-Range (cross-origin? expose Content-Range with CORS)`);
      if (state.size < 0) { state.size = total; etag = res.headers.get('etag'); }
      else if (total !== state.size) throw new Error(`${url} changed while loading (size ${state.size} → ${total})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      state.bytes += bytes.byteLength;
      return bytes;
    },
  };
}
