# gtfs-flatgeobuf

Assign the stops of a GTFS feed to the polygons that contain them — typically the French **commune (INSEE code)** of
every stop — straight from **one FlatGeobuf file on a static host**, without a backend and without downloading the file.

The same TypeScript runs in Node and in the browser (including a Web Worker): it only needs `fetch` and HTTP Range
requests. This repository contains that shared core, a Node CLI, and the script that builds the communes file from
IGN data. It does not contain a web app.

```
$ gtfs-flatgeobuf astuce-rouen.zip --fgb https://example.org/communes-2026-01-01.fgb --review
stop_id,stop_name,stop_lat,stop_lon,code,name,status,dist_to_border_m,neighbour_code,candidates
TAE:1041,Petit Clos,49.307217,1.039,76178,Cléon,NEAR_BORDER,10.5,76561,76178
TAE:1221,La Ruche,49.287061,1.019126,76231,Elbeuf,NEAR_BORDER,5,76165,76231
…
2487 stops → 95 polygons · 9 requests, 2.37 MB · header … | index … | search 19 ms | 7 feature requests … | assign 41 ms
OK 2299 · NEAR_BORDER 188
```

## The problem

The 34,877 French communes at full IGN precision, plus the 45 arrondissements of Paris, Lyon and Marseille, make a
**451 MB** FlatGeobuf file. A transit network needs a few dozen to a thousand of them. FlatGeobuf is made for this: it
starts with a spatial index, and a client can read just the bytes it needs with HTTP Range requests.

The stock way, `flatgeobuf`'s `deserialize(url, { rect })`, takes one bounding box per call:

- a bbox around a network's stops covers everything in between: the Rouen network has stops in 74 communes, its bbox
  touches 194; a regional network (Rémi, Centre-Val de Loire) ends up with 3,301 communes and 45 MB;
- each call reads the header and walks the index again, one level per round trip, so several areas mean several
  sequences of 3–4 round trips.

## How this library does it

Every stop is looked up as a point, and the whole index is searched in memory. Loading always takes **3 round trips**,
whatever the number and spread of the stops:

```
communes-2026-01-01.fgb
├─ magic + header           1.3 KB   ← round 1: first 4 KB → feature count + index node size → exact index length
├─ packed Hilbert R-tree    1.5 MB   ← round 2: the whole index, one range request
│    internal nodes (2,330) + one leaf per feature: bbox + byte offset of the feature
└─ features               449 MB    ← round 3: only the features whose bbox contains a stop,
                                       nearby ranges merged (gap < 32 KB), fetched in parallel
```

Between rounds 2 and 3 the index is walked in memory for every stop at once. The byte length of a feature is the
next leaf's offset minus its own; the last feature runs to the end of the file. Then point-in-polygon
([point-in-polygon-hao](https://github.com/rowanwins/point-in-polygon-hao), exact predicates, holes and multipolygons)
decides, and the distance to the polygon's edge flags stops that a human should look at.

**Why not reuse flatgeobuf's index search.** Its `streamSearch` (internal, in `packedrtree`) decides whether a leaf
has a next leaf with `nodeIdx < numItems - 1`, comparing an index over all nodes with the number of leaves. The last
*N* features of the file, *N* being the number of internal nodes (2,330 for the communes file: the Hilbert-ordered
tail, which covers Corsica, Finistère and the Antilles–Guyane), come back with length 0. The library's own range reader
still returns correct features, but with extra requests (12 instead of 5 for a small bbox in South Corsica). It also
logs on every node it visits, which made a 2,487-stop search take over a second in a browser. The condition is still on
flatgeobuf's main branch (4.6.0) and no issue reports it yet. The search here is synchronous, silent, and takes every point in one pass.

**One file, always consistent.** The index and the features are in the same file, so they cannot get out of sync.
Requests after the first send `If-Match: <ETag of the first response>`, and the total size in `Content-Range` is
checked: if the file is replaced while loading, the load fails instead of mixing two versions.

**Public API only.** From `flatgeobuf` this uses `geojson.deserialize` and its `headerMetaFn` option. The header is
parsed by giving `deserialize` just the header bytes; features are decoded by giving it header + index + the fetched
features back to back (without a `rect` it skips the index by length and reads features to the end of the buffer).
The index layout (40-byte nodes, root first, leaves last) comes from the
[FlatGeobuf specification](https://github.com/flatgeobuf/flatgeobuf#specification), not from library internals.

### Measured on five French GTFS feeds

Communes file: ADMIN EXPRESS COG 2026-01-01, 34,922 polygons, 451 MB, served by nginx.

| Feed (transport.data.gouv.fr) | Boarding stops | Communes with a stop | Fetched (this library) | Requests | Downloaded | Fetched with one bbox per area* | Downloaded* |
|---|---|---|---|---|---|---|---|
| Car Jaune (La Réunion) | 319 | 22 | 22 | 5 | 2.89 MB | 24 | 1.53 MB |
| Astuce (Rouen) | 2,487 | 74 | 95 | 9 | 2.37 MB | 194 | 2.21 MB |
| Citalis (La Réunion) | 1,618 | 3 | 5 | 4 | 1.77 MB | 8 | 0.62 MB |
| Kar'Ouest (La Réunion) | 2,283 | 6 | 8 | 4 | 1.95 MB | 11 | 0.88 MB |
| Rémi (Centre-Val de Loire) | 3,672 | 934 | 1,100 | 84 | **16.0 MB** | 3,301 | **45.2 MB** |

\* stops grouped in 1° cells, one `deserialize(url, { rect })` per merged bbox, as in a first version of this code.

"Fetched" counts polygons whose bbox contains a stop; "communes with a stop" is the exact minimum. The extra
1.4 MB of index is the price of a fixed 3 round trips: on a small network the bbox approach downloads less, on a
regional one this approach downloads a third.

Time is dominated by round trips, not by computation: in Chrome, on a warm connection with ~180 ms round-trip time,
the Rouen feed loads in 727 ms (header 183 ms · index 288 ms · in-memory search 13 ms · features 238 ms) and the
2,487 stops are assigned in 19 ms. A fresh connection (a CLI run) is slower: TLS setup and TCP slow start make the
1.5 MB index take several round trips, so compare CLI timings with each other, not with a browser.

## CLI

```
npm install
npm run build
node dist/cli.js <gtfs.zip> --fgb <url|path> [--format csv|json] [--flag-distance 25] [--prefer-kind COM|ARM] [--review] [--quiet]
```

| Option | |
|---|---|
| `--fgb` | FlatGeobuf file with a spatial index: an `http(s)://` URL (Range requests) or a local path. Default `$GTFS_FLATGEOBUF_FGB`. |
| `--format` | `csv` (default) or `json` on stdout. |
| `--flag-distance` | `NEAR_BORDER` below this distance to the polygon edge, in metres. Default 25 (stop GPS error ≈ 5–15 m + IGN positional accuracy). |
| `--prefer-kind` | Kind kept when two kinds overlap on purpose. `COM` (default) gives the commune code 75056 for Paris; `ARM` gives the arrondissement, 75101 … |
| `--review` | Only output stops whose status is not `OK`. |
| `--quiet` | No statistics on stderr. |

Only boarding points are assigned: `location_type` empty or `0`, with coordinates (stations, entrances and `0,0`
are skipped).

### Statuses

| Status | Meaning |
|---|---|
| `OK` | Inside one polygon, farther than `--flag-distance` from its edge. |
| `NEAR_BORDER` | Inside one polygon but close to its edge; `neighbour_code` is the polygon across the edge when it was loaded. |
| `ON_BORDER` | Exactly on an edge (exact predicate). |
| `MULTI` | Inside several polygons of the same kind (overlapping data). |
| `NO_MATCH` | Inside no polygon: at sea, abroad, or just outside a coastline. |

## Library

```ts
import { readFile } from 'node:fs/promises';
import { assignStops, httpRangeSource, readStopsFromZip } from 'gtfs-flatgeobuf';
import { fileRangeSource } from 'gtfs-flatgeobuf/node';

const stops = readStopsFromZip(new Uint8Array(await readFile('astuce-rouen.zip')));
const source = httpRangeSource('https://example.org/communes-2026-01-01.fgb'); // or fileRangeSource('communes-2026-01-01.fgb')
const { assignments, stats } = await assignStops(source, stops, { flagDistanceM: 25 });
// assignments[i] → { id, code: '76540', name: 'Rouen', status: 'OK', distToBorderM, neighbourCode, candidates }
```

Everything exported from `gtfs-flatgeobuf` is platform-neutral (no Node built-ins): in a browser or a Web Worker,
pass the zip bytes from a file input or a `fetch` and use `httpRangeSource`. `gtfs-flatgeobuf/node` adds
`fileRangeSource` (local files, same interface) and `openFgb` (URL or path).

Lower-level pieces:

| Export | |
|---|---|
| `loadFeaturesAtPoints(source, points)` | The 3-round-trip loader: GeoJSON features whose bbox contains a point, plus request/byte/timing stats. Works with any FlatGeobuf file that has a spatial index. |
| `PolygonIndex` | Point-in-polygon + border distance over those features. Property names default to `insee` / `nom` / `kind` and are configurable. |
| `searchPoints`, `treeLevels`, `treeByteLength` | The in-memory index search and the packed R-tree layout. |
| `readStopsFromZip`, `parseStopsTxt`, `parseCsv` | GTFS `stops.txt` reading. |
| `httpRangeSource`, `RangeSource` | Range requests with ETag pinning; implement `RangeSource` for any other storage. |

## Building the communes file

```
scripts/prepare-communes.sh 2026-01-01 work
```

Downloads IGN [ADMIN EXPRESS COG](https://geoservices.ign.fr/adminexpress) (GeoPackage, already in WGS84, ≈ 600 MB),
keeps `insee`, `nom`, `dep`, `kind` for communes (`COM`) and municipal arrondissements (`ARM`), repairs geometries,
fails on invalid, empty or duplicate polygons, and writes `communes-<vintage>.fgb` with its spatial index. Needs GDAL
≥ 3.8 and `bsdtar` or `7z`.

- Use the **COG** edition (aligned with that year's INSEE Code officiel géographique), not COG CARTO, which is
  generalised for display.
- **Do not simplify.** Simplifying borders by 10 m still reassigns stops 25–50 m away from a border.
- INSEE codes change every 1 January (communes nouvelles). Store the vintage next to the code, and treat "same stop,
  different code" between vintages as a vintage change, not as a moved stop.

### Serving it

- **Range requests** must be honoured (`206 Partial Content`); otherwise the loader fails rather than download 451 MB.
- **No compression** on the `.fgb` (Range and `Content-Encoding` do not mix).
- An **ETag** lets the loader detect a file replaced mid-load (nginx sends one for static files).
- **Cross-origin:** allow the `Range` and `If-Match` request headers and expose `Content-Range` and `ETag`.

## Limitations

- **Neighbour.** Only polygons whose bbox contains a stop are fetched. `neighbour_code` is therefore filled only when
  the polygon across the nearest edge also has a bbox containing the stop; the `NEAR_BORDER` flag itself does not
  depend on it.
- **Coastline.** IGN polygons follow the coastline; a stop at the water's edge can be `NO_MATCH` (one Citalis stop,
  "Hôtel de Ville de Ste Marie", is). Those go to human review; no nearest-polygon fallback is attempted.
- **Overseas.** The five DROM are in ADMIN EXPRESS. Saint-Pierre-et-Miquelon, Saint-Barthélemy, Saint-Martin, Wallis-et-Futuna,
  French Polynesia and New Caledonia are not, and come back `NO_MATCH`.

## Development

```
npm test        # builds, then runs vitest against test/fixtures/grid.fgb
node test/fixtures/make-fixture.mjs   # regenerate the fixture (needs ogr2ogr)
```

The fixture has 40 polygons: a grid, an enclave in a hole, a two-island MultiPolygon and two arrondissements over one
commune, so that the last leaves of the index and the last feature of the file are covered.

## License

Code: MIT. Communes data: IGN ADMIN EXPRESS, [Licence Ouverte / Open Licence Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
GTFS feeds: see each dataset on [transport.data.gouv.fr](https://transport.data.gouv.fr).
