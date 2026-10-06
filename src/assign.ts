// Point-in-polygon assignment of stops to the polygons loaded from the FlatGeobuf file, with border flags
// for human review. Pure computation: same in Node, browsers and Web Workers.
import Flatbush from 'flatbush';
import pointInPolygon from 'point-in-polygon-hao';

export type Status = 'OK' | 'NEAR_BORDER' | 'ON_BORDER' | 'MULTI' | 'NO_MATCH';

export type Assignment = {
  id: string;
  /** Code of the polygon containing the stop (INSEE code for communes), null if none. */
  code: string | null;
  name: string | null;
  status: Status;
  /** Distance from the stop to the nearest edge of its polygon, in metres (0.1 m precision). */
  distToBorderM: number | null;
  /** Polygon across that edge, when it was loaded (its bbox also contains the stop). */
  neighbourCode: string | null;
  /** Every code whose polygon contains the stop (more than one only for MULTI). */
  candidates: string[];
};

export type PolygonIndexOptions = {
  /** Feature properties holding the code, the name and the kind. Defaults: insee, nom, kind. */
  codeProperty?: string;
  nameProperty?: string;
  kindProperty?: string;
  /**
   * When polygons of two kinds overlap on purpose — a French commune (kind COM) and its municipal arrondissements
   * (kind ARM) in Paris, Lyon and Marseille — keep this kind and do not flag the overlap. Default: COM.
   */
  preferKind?: string;
};

type Ring = number[][];
type Polygon = { code: string; name: string; kind: string; polys: Ring[][]; bbox: [number, number, number, number] };

const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

function bboxOf(polys: Ring[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

/** true = inside, 0 = exactly on an edge (robust predicates), false = outside. Holes (enclaves) are honoured. */
function contains(p: Polygon, pt: [number, number]): true | 0 | false {
  let onEdge = false;
  for (const rings of p.polys) {
    const r = pointInPolygon(pt, rings);
    if (r === true) return true;
    if (r === 0) onEdge = true;
  }
  return onEdge ? 0 : false;
}

/** Distance (m) from pt to the nearest edge of p; local equirectangular approximation (< 0.1 % error at commune scale). */
function distToBorderM(p: Polygon, pt: [number, number]): number {
  const kx = mPerDegLon(pt[1]), ky = M_PER_DEG_LAT;
  let best = Infinity;
  for (const rings of p.polys) for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - pt[0]) * kx, ay = (ring[i - 1][1] - pt[1]) * ky;
    const bx = (ring[i][0] - pt[0]) * kx, by = (ring[i][1] - pt[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let u = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = ax + u * dx, py = ay + u * dy, d = px * px + py * py;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export class PolygonIndex {
  private polygons: Polygon[];
  private index: Flatbush | null;
  private preferKind: string;

  constructor(features: GeoJSON.Feature[], options: PolygonIndexOptions = {}) {
    const { codeProperty = 'insee', nameProperty = 'nom', kindProperty = 'kind' } = options;
    this.preferKind = options.preferKind ?? 'COM';
    this.polygons = [];
    for (const f of features) {
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
      const polys = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as Ring[][];
      this.polygons.push({
        code: String(f.properties?.[codeProperty] ?? ''), name: String(f.properties?.[nameProperty] ?? ''),
        kind: String(f.properties?.[kindProperty] ?? ''), polys, bbox: bboxOf(polys),
      });
    }
    this.index = null;
    if (this.polygons.length > 0) {
      this.index = new Flatbush(this.polygons.length);
      for (const p of this.polygons) this.index.add(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);
      this.index.finish();
    }
  }

  get size() { return this.polygons.length; }

  /** Assign one stop. NEAR_BORDER when closer than flagDistanceM to the edge of its polygon. */
  assign(stop: { id: string; lon: number; lat: number }, flagDistanceM = 25): Assignment {
    const pt: [number, number] = [stop.lon, stop.lat];
    const none: Assignment = { id: stop.id, code: null, name: null, status: 'NO_MATCH', distToBorderM: null, neighbourCode: null, candidates: [] };
    if (!this.index) return none;

    const hits: Polygon[] = [];
    let onEdge = false;
    for (const i of this.index.search(stop.lon, stop.lat, stop.lon, stop.lat)) {
      const r = contains(this.polygons[i], pt);
      if (r === true) hits.push(this.polygons[i]); else if (r === 0) onEdge = true;
    }
    if (hits.length === 0) return onEdge ? { ...none, status: 'ON_BORDER' } : none;

    // Intended overlap of two kinds (commune + arrondissement): keep the preferred kind, not an ambiguity.
    let chosen = hits;
    const kinds = new Set(hits.map(h => h.kind));
    if (kinds.size > 1 && kinds.has(this.preferKind)) chosen = hits.filter(h => h.kind === this.preferKind);
    const candidates = hits.map(h => h.code);
    if (chosen.length !== 1) return { ...none, status: 'MULTI', candidates, code: chosen[0]?.code ?? null, name: chosen[0]?.name ?? null };

    const p = chosen[0];
    const d = distToBorderM(p, pt);
    let neighbourCode: string | null = null;
    if (d < flagDistanceM) {
      const dx = (flagDistanceM * 2) / mPerDegLon(stop.lat), dy = (flagDistanceM * 2) / M_PER_DEG_LAT;
      let bestD = Infinity;
      for (const i of this.index.search(stop.lon - dx, stop.lat - dy, stop.lon + dx, stop.lat + dy)) {
        const o = this.polygons[i];
        if (o === p || o.kind !== p.kind) continue;
        const od = distToBorderM(o, pt);
        if (od < bestD) { bestD = od; neighbourCode = o.code; }
      }
    }
    return {
      id: stop.id, code: p.code, name: p.name,
      status: onEdge ? 'ON_BORDER' : d < flagDistanceM ? 'NEAR_BORDER' : 'OK',
      distToBorderM: Math.round(d * 10) / 10, neighbourCode, candidates,
    };
  }
}
