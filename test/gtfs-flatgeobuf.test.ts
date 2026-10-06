import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { geojson } from 'flatgeobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignStops, httpRangeSource, loadFeaturesAtPoints, parseStopsTxt, PolygonIndex, readStopsFromZip, treeLevels, type Point,
} from '../src/index.js';
import { fileRangeSource } from '../src/node/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/grid.fgb', import.meta.url));
const fixtureBytes = readFileSync(FIXTURE);
const M = 1 / 110540; // ≈ 1 m of latitude in degrees

/** Every feature of the fixture, decoded by flatgeobuf from the whole file: the reference. */
async function allFeatures() {
  const out: GeoJSON.Feature[] = [];
  for await (const f of geojson.deserialize(new Uint8Array(fixtureBytes))) out.push(f as unknown as GeoJSON.Feature);
  return out;
}

/** A point strictly inside the first ring of a feature (its rings are axis-aligned rectangles). */
function inside(f: GeoJSON.Feature): Point {
  const g = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  const ring = (g.type === 'Polygon' ? g.coordinates : g.coordinates[0])[0];
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return [x0 + (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.1]; // near a corner: clear of C22's hole
}

describe('treeLevels (FlatGeobuf packed R-tree layout)', () => {
  it('puts the root first and the leaves last', () => {
    expect(treeLevels(40, 16)).toEqual([[4, 44], [1, 4], [0, 1]]);
    expect(treeLevels(34922, 16)[0]).toEqual([2330, 37252]); // French communes: 2,330 internal nodes
    expect(treeLevels(1, 16)).toEqual([[1, 2], [0, 1]]);
    expect(treeLevels(16, 16)).toEqual([[1, 17], [0, 1]]);
    expect(treeLevels(17, 16)).toEqual([[3, 20], [1, 3], [0, 1]]);
  });
});

describe('loadFeaturesAtPoints', () => {
  it('returns every feature containing a point — including the last leaves and the last feature of the file', async () => {
    const reference = await allFeatures();
    expect(reference).toHaveLength(40);
    const source = fileRangeSource(FIXTURE);
    const { features, stats } = await loadFeaturesAtPoints(source, reference.map(inside));
    const key = (f: GeoJSON.Feature) => JSON.stringify([f.properties, f.geometry]);
    expect(new Set(features.map(key))).toEqual(new Set(reference.map(key)));
    expect(stats.requests).toBe(1 + stats.featureRequests); // the fixture's header and index both fit in the first 4 KB read
  });

  it('fetches only the features whose bbox contains a point', async () => {
    const { features } = await loadFeaturesAtPoints(fileRangeSource(FIXTURE), [[0.05, 0.05], [0.72, 0.42]]);
    expect(features.map(f => f.properties?.insee).sort()).toEqual(['C00', 'MP']);
  });

  it('makes 3 round trips: header, index, features', async () => {
    const reads: Array<[number, number]> = [];
    const file = fileRangeSource(FIXTURE);
    const spy = { ...file, read: (s: number, e: number) => { reads.push([s, e]); return file.read(s, e); } };
    Object.defineProperty(spy, 'size', { get: () => file.size });
    // tiny first read so that the header and the index need their own requests, as with a real file
    await loadFeaturesAtPoints(spy as typeof file, [[0.05, 0.05]], { firstRequestBytes: 16 });
    expect(reads.length).toBe(4); // 16 bytes, rest of the header, index, one feature
    expect(reads[0]).toEqual([0, 16]);
  });

  it('rejects a file that is not FlatGeobuf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtfs-fgb-test-'));
    writeFileSync(join(dir, 'x.fgb'), 'hello world, definitely not a flatgeobuf file');
    await expect(loadFeaturesAtPoints(fileRangeSource(join(dir, 'x.fgb')), [[0, 0]])).rejects.toThrow('not a FlatGeobuf file');
  });
});

describe('PolygonIndex.assign', () => {
  let index: PolygonIndex, arm: PolygonIndex;
  beforeAll(async () => {
    const features = await allFeatures();
    index = new PolygonIndex(features);
    arm = new PolygonIndex(features, { preferKind: 'ARM' });
  });
  const at = (lon: number, lat: number) => ({ id: 's', lon, lat });

  it('OK in the middle of a polygon', () => {
    expect(index.assign(at(0.05, 0.05))).toMatchObject({ code: 'C00', status: 'OK', candidates: ['C00'] });
  });
  it('NEAR_BORDER with the neighbour across the edge', () => {
    const a = index.assign(at(0.05, 0.1 - 10 * M)); // 10 m south of the C00 / C01 edge
    expect(a).toMatchObject({ code: 'C00', status: 'NEAR_BORDER', neighbourCode: 'C01' });
    expect(a.distToBorderM).toBeCloseTo(10, 0);
  });
  it('ON_BORDER exactly on a shared edge', () => {
    expect(index.assign(at(0.05, 0.1))).toMatchObject({ status: 'ON_BORDER', code: null });
  });
  it('the enclave wins over the polygon around it (hole)', () => {
    expect(index.assign(at(0.25, 0.25))).toMatchObject({ code: 'ENC', status: 'OK' });
  });
  it('MultiPolygon: both islands', () => {
    expect(index.assign(at(0.72, 0.12)).code).toBe('MP');
    expect(index.assign(at(0.72, 0.42)).code).toBe('MP');
  });
  it('NO_MATCH outside every polygon', () => {
    expect(index.assign(at(0.72, 0.3))).toMatchObject({ code: null, status: 'NO_MATCH' });
  });
  it('commune vs arrondissements: preferred kind, not MULTI', () => {
    expect(index.assign(at(0.42, 0.42))).toMatchObject({ code: 'C44', candidates: expect.arrayContaining(['C44', 'A1']) });
    expect(arm.assign(at(0.42, 0.42))).toMatchObject({ code: 'A1' });
    expect(arm.assign(at(0.48, 0.42))).toMatchObject({ code: 'A2' });
  });
});

describe('httpRangeSource', () => {
  let server: Server, url: string, etag = '"v1"', mode: 'ok' | 'no-range' = 'ok';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (mode === 'no-range' || !m) { res.writeHead(200, { 'content-length': fixtureBytes.length }); res.end(fixtureBytes); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412); res.end(); return; }
      const s = +m[1], e = Math.min(+m[2], fixtureBytes.length - 1);
      res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${fixtureBytes.length}`, etag });
      res.end(fixtureBytes.subarray(s, e + 1));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/grid.fgb`;
  });
  afterAll(() => server.close());

  it('loads and assigns over HTTP', async () => {
    const { assignments, stats } = await assignStops(httpRangeSource(url), [{ id: 'a', lon: 0.25, lat: 0.25 }, { id: 'b', lon: 0.55, lat: 0.55 }]);
    expect(assignments.map(a => a.code)).toEqual(['ENC', 'C55']);
    expect(stats.requests).toBe(2); // the fixture's header and index fit in the first read; features in one more
  });
  it('fails if the file changes between requests (If-Match → 412)', async () => {
    const source = httpRangeSource(url);
    await source.read(0, 16);
    etag = '"v2"';
    try { await expect(source.read(16, 32)).rejects.toThrow('changed while loading'); } finally { etag = '"v1"'; }
  });
  it('fails clearly when the server ignores Range', async () => {
    mode = 'no-range';
    try { await expect(httpRangeSource(url).read(0, 16)).rejects.toThrow('206'); } finally { mode = 'ok'; }
  });
});

describe('GTFS stops', () => {
  const STOPS = '﻿stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\r\n' +
    'S1,"Gare, quai 1",0.05,0.05,0,ST\r\n' +
    'ST,Gare,0.05,0.05,1,\r\n' +
    'S2,"Le ""Centre""",0.25,0.25,,\r\n' +
    'S3,Nulle part,0,0,0,\r\n' +
    'S4,Sans coordonnées,,,0,\r\n';

  it('keeps boarding points with coordinates, handles quotes, BOM and CRLF', () => {
    expect(parseStopsTxt(STOPS)).toEqual([
      { id: 'S1', name: 'Gare, quai 1', lat: 0.05, lon: 0.05 },
      { id: 'S2', name: 'Le "Centre"', lat: 0.25, lon: 0.25 },
    ]);
  });
  it('reads stops.txt from a zip, also inside a folder', () => {
    expect(readStopsFromZip(zipSync({ 'stops.txt': strToU8(STOPS) }))).toHaveLength(2);
    expect(readStopsFromZip(zipSync({ 'feed/stops.txt': strToU8(STOPS) }))).toHaveLength(2);
    expect(() => readStopsFromZip(zipSync({ 'routes.txt': strToU8('x') }))).toThrow('no stops.txt');
  });
});

describe('CLI', () => {
  it('writes one CSV row per stop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtfs-fgb-cli-'));
    const zip = join(dir, 'gtfs.zip');
    writeFileSync(zip, zipSync({ 'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,In C00,0.05,0.05\nB,Enclave,0.25,0.25\nC,Sea,0.3,0.72\n') }));
    // runs the built CLI (npm test builds first)
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), zip, '--fgb', FIXTURE, '--quiet'], { encoding: 'utf8' });
    const [header, ...rows] = out.trim().split('\n').map(l => l.split(','));
    expect(header).toEqual(['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'code', 'name', 'status', 'dist_to_border_m', 'neighbour_code', 'candidates']);
    expect(rows.map(r => [r[0], r[4], r[6]])).toEqual([['A', 'C00', 'OK'], ['B', 'ENC', 'OK'], ['C', '', 'NO_MATCH']]);
  });
});
