// Node-only helpers: read a local .fgb through the same RangeSource interface as HTTP.
import { open, stat } from 'node:fs/promises';
import { httpRangeSource, type RangeSource } from '../range-source.js';

/**
 * Byte ranges of a local file. The file's size and modification time are captured on the first read and checked
 * on every read, the local equivalent of the ETag pinning done over HTTP.
 */
export function fileRangeSource(path: string): RangeSource {
  const state = { size: -1, mtimeMs: -1, requests: 0, bytes: 0 };
  return {
    get size() { return state.size; },
    get requests() { return state.requests; },
    get bytes() { return state.bytes; },
    async read(start, end) {
      const handle = await open(path, 'r');
      try {
        const { size, mtimeMs } = await handle.stat();
        if (state.size < 0) { state.size = size; state.mtimeMs = mtimeMs; }
        else if (size !== state.size || mtimeMs !== state.mtimeMs) throw new Error(`${path} changed while loading`);
        const length = Math.max(0, Math.min(end, size) - start);
        const bytes = new Uint8Array(length);
        const { bytesRead } = await handle.read(bytes, 0, length, start);
        state.requests++;
        state.bytes += bytesRead;
        return bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

/** http(s):// URL → HTTP range requests; anything else → local file. */
export async function openFgb(location: string): Promise<RangeSource> {
  if (/^https?:\/\//i.test(location)) return httpRangeSource(location);
  await stat(location); // fail early with ENOENT
  return fileRangeSource(location);
}
