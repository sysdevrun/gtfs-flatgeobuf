// Stops from a GTFS feed: only what the assignment needs (id, name, coordinates), from the zip bytes,
// so it runs the same in Node and in the browser.
import { strFromU8, unzipSync } from 'fflate';

export type Stop = { id: string; name: string; lat: number; lon: number };

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF, leading BOM. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out.filter(r => r.some(c => c.trim()));
}

/**
 * Boarding points of a GTFS stops.txt: location_type empty or 0 (stations, entrances, generic nodes and boarding
 * areas are skipped: they are not where vehicles stop, and a station's platforms carry their own coordinates).
 * Rows without usable coordinates (missing, non-numeric, 0,0) are skipped.
 */
export function parseStopsTxt(text: string): Stop[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const h = header.map(c => c.trim());
  const col = (name: string) => h.indexOf(name);
  const iId = col('stop_id'), iName = col('stop_name'), iLat = col('stop_lat'), iLon = col('stop_lon'), iType = col('location_type');
  if (iId < 0 || iLat < 0 || iLon < 0) throw new Error('stops.txt: stop_id, stop_lat and stop_lon are required');
  const stops: Stop[] = [];
  for (const r of rows) {
    const type = iType >= 0 ? (r[iType] ?? '').trim() : '';
    if (type !== '' && type !== '0') continue;
    const lat = Number(r[iLat]), lon = Number(r[iLon]);
    if (!r[iLat]?.trim() || !r[iLon]?.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    stops.push({ id: r[iId], name: iName >= 0 ? r[iName] ?? '' : '', lat, lon });
  }
  return stops;
}

/** Boarding points from the bytes of a GTFS zip (stops.txt at the root or in a single sub-folder). */
export function readStopsFromZip(zip: Uint8Array): Stop[] {
  const files = unzipSync(zip, { filter: f => f.name === 'stops.txt' || f.name.endsWith('/stops.txt') });
  const entry = Object.values(files)[0];
  if (!entry) throw new Error('no stops.txt in the GTFS zip');
  return parseStopsTxt(strFromU8(entry));
}
