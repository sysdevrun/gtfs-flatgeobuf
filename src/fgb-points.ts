// Fetch, from one FlatGeobuf file, exactly the features whose bbox contains at least one of the given points.
//
// 3 round trips, whatever the number or spread of the points:
//   1. the first few KB: magic bytes + header → feature count and index node size → exact byte length of the index
//   2. the whole packed R-tree index in one range (1.5 MB for the 34,922 French communes)
//   3. the matching features, as coalesced ranges fetched in parallel
// Between 2 and 3 the index is searched in memory for every point at once.
//
// Only flatgeobuf's public API is used (geojson.deserialize and its headerMetaFn option). The byte layout comes from
// the FlatGeobuf specification: 8 magic bytes, a size-prefixed header, then the packed Hilbert R-tree (40-byte nodes,
// root first, leaves last), then size-prefixed features in leaf order.
import { geojson, type HeaderMeta } from 'flatgeobuf';
import type { RangeSource } from './range-source.js';

const MAGIC = [0x66, 0x67, 0x62]; // "fgb"; byte 3 is the major version, bytes 4–7 "fgb" + patch
const MAGIC_LEN = 8;
const SIZE_PREFIX_LEN = 4;        // uint32 little-endian length before the header and before each feature
const NODE_BYTES = 40;            // index node: minX, minY, maxX, maxY (float64) + offset (uint64)

export type Point = [lon: number, lat: number];
type Range = [start: number, end: number]; // bytes, end exclusive

export type LoadOptions = {
  /** Size of the first request; a bigger header costs one extra request. Default 4096. */
  firstRequestBytes?: number;
  /** Feature ranges closer than this are fetched in one request. Default 32 KiB. */
  featureGapBytes?: number;
};

export type LoadStats = {
  requests: number;
  bytes: number;
  headerMs: number;   // round 1
  indexMs: number;    // round 2
  searchMs: number;   // in-memory index search
  featuresMs: number; // round 3 + decoding
  featureRequests: number;
  features: number;
};

/** Packed R-tree levels as [first, end) node indices, leaves first, root last. Root is node 0, leaves are at the end. */
export function treeLevels(numItems: number, nodeSize: number): Array<[number, number]> {
  if (numItems < 1 || nodeSize < 2) throw new Error('invalid index: need at least 1 item and node size ≥ 2');
  const counts = [numItems];
  let n = numItems;
  do { n = Math.ceil(n / nodeSize); counts.push(n); } while (n !== 1);
  let end = counts.reduce((a, b) => a + b, 0);
  return counts.map(c => { const level: [number, number] = [end - c, end]; end -= c; return level; });
}

export const treeByteLength = (numItems: number, nodeSize: number) => treeLevels(numItems, nodeSize)[0][1] * NODE_BYTES;

/**
 * Leaves of an in-memory packed R-tree whose bbox contains at least one point:
 * feature index, and byte offset of the feature and of the next one (relative to the start of the feature data;
 * null for the last feature, which runs to the end of the file).
 * Assumes a little-endian host, like every browser platform and Node on x86/ARM.
 */
export function searchPoints(tree: Uint8Array, numItems: number, nodeSize: number, points: Iterable<Point>) {
  const levels = treeLevels(numItems, nodeSize);
  const [firstLeaf, endLeaf] = levels[0];
  if (tree.byteLength < endLeaf * NODE_BYTES) throw new Error('index buffer too short');
  const aligned = tree.byteOffset % 8 === 0 ? tree : tree.slice();
  const coords = new Float64Array(aligned.buffer, aligned.byteOffset, endLeaf * 5); // 5 float64 slots per node
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, endLeaf * 10);  // node offset = words 8 (low) + 9 (high)
  const offsetOf = (i: number) => words[i * 10 + 8] + words[i * 10 + 9] * 2 ** 32;

  const found = new Map<number, { index: number; offset: number; nextOffset: number | null }>();
  const stack: Array<[node: number, level: number]> = [];
  for (const [x, y] of points) {
    stack.push([levels[levels.length - 1][0], levels.length - 1]);
    while (stack.length) {
      const [i, level] = stack.pop()!;
      const o = i * 5;
      if (x < coords[o] || y < coords[o + 1] || x > coords[o + 2] || y > coords[o + 3]) continue;
      if (level === 0) {
        if (!found.has(i)) found.set(i, { index: i - firstLeaf, offset: offsetOf(i), nextOffset: i + 1 < endLeaf ? offsetOf(i + 1) : null });
        continue;
      }
      const first = offsetOf(i), end = Math.min(first + nodeSize, levels[level - 1][1]);
      for (let c = first; c < end; c++) stack.push([c, level - 1]);
    }
  }
  return [...found.values()];
}

function coalesce(ranges: Range[], gap: number): Range[][] {
  const groups: Range[][] = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const g = groups[groups.length - 1];
    if (g && r[0] - g[g.length - 1][1] <= gap) g.push(r); else groups.push([r]);
  }
  return groups;
}

/** Parse a header with the public deserializer: given only magic + header bytes it reports the header and yields nothing. */
async function parseHeader(bytes: Uint8Array): Promise<HeaderMeta> {
  let header: HeaderMeta | undefined;
  for await (const _ of geojson.deserialize(bytes, { headerMetaFn: (h: HeaderMeta) => { header = h; } })) break;
  if (!header) throw new Error('could not parse the FlatGeobuf header');
  return header;
}

const now = () => performance.now();

/** Features (as GeoJSON) whose bbox contains at least one point, from a FlatGeobuf file with a spatial index. */
export async function loadFeaturesAtPoints(source: RangeSource, points: Point[], options: LoadOptions = {}): Promise<{ header: HeaderMeta; features: GeoJSON.Feature[]; stats: LoadStats }> {
  const firstRequestBytes = options.firstRequestBytes ?? 4096;
  const featureGapBytes = options.featureGapBytes ?? 32 * 1024;
  const t0 = now();

  // ---- round 1: header ----
  let head = await source.read(0, firstRequestBytes);
  if (!MAGIC.every((b, i) => head[i] === b)) throw new Error('not a FlatGeobuf file');
  const headerLength = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(MAGIC_LEN, true);
  const headerEnd = MAGIC_LEN + SIZE_PREFIX_LEN + headerLength;
  if (head.byteLength < headerEnd) { // unusually large header: fetch the rest of it
    const all = new Uint8Array(headerEnd);
    all.set(head); all.set(await source.read(head.byteLength, headerEnd), head.byteLength);
    head = all;
  }
  const header = await parseHeader(head.subarray(0, headerEnd));
  if (!header.indexNodeSize) throw new Error('the FlatGeobuf file has no spatial index (write it with SPATIAL_INDEX=YES)');
  const treeLength = treeByteLength(header.featuresCount, header.indexNodeSize);
  const featuresStart = headerEnd + treeLength;
  const t1 = now();

  // ---- round 2: the whole index (minus what round 1 already returned) ----
  const tree = new Uint8Array(treeLength);
  const inHead = Math.max(0, Math.min(head.byteLength, featuresStart) - headerEnd);
  tree.set(head.subarray(headerEnd, headerEnd + inHead));
  if (inHead < treeLength) tree.set(await source.read(headerEnd + inHead, featuresStart), inHead);
  const t2 = now();

  // ---- in memory: features whose bbox contains a point ----
  const ranges: Range[] = searchPoints(tree, header.featuresCount, header.indexNodeSize, points)
    .map(l => [featuresStart + l.offset, l.nextOffset === null ? source.size : featuresStart + l.nextOffset]);
  const t3 = now();

  // ---- round 3: features, coalesced ranges in parallel ----
  const groups = coalesce(ranges, featureGapBytes);
  const pieces = (await Promise.all(groups.map(async g => {
    const start = g[0][0];
    const buf = await source.read(start, g[g.length - 1][1]);
    return g.map(([s, e]) => buf.subarray(s - start, e - start)); // each piece = size prefix + feature
  }))).flat();

  // Decode with the public deserializer: header + index + only the fetched features, back to back. Without a rect
  // it skips the index by its length (from the header) and reads size-prefixed features to the end of the buffer.
  const decodable = new Uint8Array(featuresStart + pieces.reduce((a, p) => a + p.byteLength, 0));
  decodable.set(head.subarray(0, headerEnd));
  decodable.set(tree, headerEnd);
  let at = featuresStart;
  for (const p of pieces) { decodable.set(p, at); at += p.byteLength; }
  const features: GeoJSON.Feature[] = [];
  for await (const f of geojson.deserialize(decodable)) features.push(f as unknown as GeoJSON.Feature);
  if (features.length !== pieces.length) throw new Error(`decoded ${features.length} features, expected ${pieces.length}`);
  const t4 = now();

  return {
    header,
    features,
    stats: {
      requests: source.requests, bytes: source.bytes,
      headerMs: t1 - t0, indexMs: t2 - t1, searchMs: t3 - t2, featuresMs: t4 - t3,
      featureRequests: groups.length, features: features.length,
    },
  };
}
