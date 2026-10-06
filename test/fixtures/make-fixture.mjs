// Regenerates test/fixtures/grid.fgb (needs GDAL's ogr2ogr): node test/fixtures/make-fixture.mjs
//
// 40 polygons in EPSG:4326, cells of 0.1° starting at lon 0 / lat 0:
//   - C<col><row>: a 6×6 grid of square communes (kind COM), C22 has a hole …
//   - ENC: … filled by an enclave commune
//   - MP: a two-island MultiPolygon east of the grid
//   - A1, A2: two arrondissements (kind ARM) splitting C44 in halves, overlapping it on purpose
// 40 features with the default node size 16 give a 3-level index (1 + 3 internal nodes), so the last
// leaves of the index and the last feature of the file are both exercised by the tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 0.1;
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const features = [];
const add = (insee, nom, kind, geometry) => features.push({ type: 'Feature', properties: { insee, nom, kind }, geometry });
for (let c = 0; c < 6; c++) for (let r = 0; r < 6; r++) {
  const outer = square(c * S, r * S, (c + 1) * S, (r + 1) * S);
  if (c === 2 && r === 2) add('C22', 'Cell 2-2', 'COM', { type: 'Polygon', coordinates: [outer, square(0.23, 0.23, 0.27, 0.27).reverse()] });
  else add(`C${c}${r}`, `Cell ${c}-${r}`, 'COM', { type: 'Polygon', coordinates: [outer] });
}
add('ENC', 'Enclave', 'COM', { type: 'Polygon', coordinates: [square(0.23, 0.23, 0.27, 0.27)] });
add('MP', 'Islands', 'COM', { type: 'MultiPolygon', coordinates: [[square(0.70, 0.10, 0.75, 0.15)], [square(0.70, 0.40, 0.75, 0.45)]] });
add('A1', 'Arrondissement 1', 'ARM', { type: 'Polygon', coordinates: [square(0.4, 0.4, 0.45, 0.5)] });
add('A2', 'Arrondissement 2', 'ARM', { type: 'Polygon', coordinates: [square(0.45, 0.4, 0.5, 0.5)] });

const tmp = mkdtempSync(join(tmpdir(), 'gtfs-fgb-'));
try {
  const src = join(tmp, 'grid.geojson');
  writeFileSync(src, JSON.stringify({ type: 'FeatureCollection', features }));
  const out = join(dirname(fileURLToPath(import.meta.url)), 'grid.fgb');
  rmSync(out, { force: true });
  execFileSync('ogr2ogr', ['-f', 'FlatGeobuf', out, src, '-nln', 'grid', '-a_srs', 'EPSG:4326', '-lco', 'SPATIAL_INDEX=YES'], { stdio: 'inherit' });
  console.log(`wrote ${out} (${features.length} features)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
