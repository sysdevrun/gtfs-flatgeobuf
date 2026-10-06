#!/usr/bin/env node
// gtfs-flatgeobuf CLI — assign the stops of a GTFS zip to the polygons of a FlatGeobuf file (URL or local path).
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assignStops, readStopsFromZip, type Assignment, type Stop } from './index.js';
import { openFgb } from './node/index.js';

const USAGE = `Usage: gtfs-flatgeobuf <gtfs.zip> --fgb <url|path> [options]

Assigns every boarding point of the GTFS feed (stops.txt, location_type 0) to the polygon that contains it,
fetching only the FlatGeobuf header, its index and the polygons that contain a stop.

Options:
  --fgb <url|path>        FlatGeobuf file with a spatial index (http(s) URL with Range support, or local file)
                          (default: $GTFS_FLATGEOBUF_FGB)
  --format csv|json       output format on stdout (default: csv)
  --flag-distance <m>     NEAR_BORDER below this distance to the polygon edge (default: 25)
  --prefer-kind <kind>    kind kept when two kinds overlap on purpose, e.g. COM or ARM (default: COM)
  --review                only output stops that need a human look (status other than OK)
  --quiet                 no statistics on stderr
  -h, --help              this help

Statistics (requests, bytes, timings, status counts) go to stderr.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fgb: { type: 'string' },
    format: { type: 'string', default: 'csv' },
    'flag-distance': { type: 'string', default: '25' },
    'prefer-kind': { type: 'string', default: 'COM' },
    review: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const fgb = opts.fgb ?? process.env.GTFS_FLATGEOBUF_FGB;
if (opts.help || positionals.length !== 1 || !fgb || !['csv', 'json'].includes(opts.format!)) {
  console.error(USAGE);
  process.exit(opts.help ? 0 : 2);
}
const flagDistanceM = Number(opts['flag-distance']);
if (!(flagDistanceM >= 0)) { console.error('--flag-distance must be a number ≥ 0'); process.exit(2); }

// `gtfs-flatgeobuf … | head` closes stdout early: stop quietly.
process.stdout.on('error', err => { if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw err; });

const csvField = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

try {
  const stops = readStopsFromZip(new Uint8Array(await readFile(positionals[0])));
  const source = await openFgb(fgb);
  const { assignments, polygons, stats } = await assignStops(source, stops, { flagDistanceM, preferKind: opts['prefer-kind'] });

  const rows: Array<[Stop, Assignment]> = stops.map((s, i) => [s, assignments[i]]);
  const out = opts.review ? rows.filter(([, a]) => a.status !== 'OK') : rows;
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(out.map(([s, a]) => ({ ...a, stopName: s.name, lat: s.lat, lon: s.lon })), null, 2) + '\n');
  } else {
    process.stdout.write('stop_id,stop_name,stop_lat,stop_lon,code,name,status,dist_to_border_m,neighbour_code,candidates\n');
    for (const [s, a] of out) {
      process.stdout.write([s.id, s.name, s.lat, s.lon, a.code, a.name, a.status, a.distToBorderM, a.neighbourCode, a.candidates.join(' ')].map(csvField).join(',') + '\n');
    }
  }

  if (!opts.quiet) {
    const counts = new Map<string, number>();
    for (const a of assignments) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    const ms = (v: number) => `${v.toFixed(0)} ms`;
    console.error(
      `${stops.length} stops → ${polygons} polygons · ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(2)} MB · ` +
      `header ${ms(stats.headerMs)} | index ${ms(stats.indexMs)} | search ${ms(stats.searchMs)} | ` +
      `${stats.featureRequests} feature requests ${ms(stats.featuresMs)} | assign ${ms(stats.assignMs)}\n` +
      [...counts].map(([k, v]) => `${k} ${v}`).join(' · '),
    );
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
}
