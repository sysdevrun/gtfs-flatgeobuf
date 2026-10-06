// gtfs-flatgeobuf — assign GTFS stops to polygons from a single FlatGeobuf file (browser, Web Worker and Node).
import { PolygonIndex, type Assignment, type PolygonIndexOptions } from './assign.js';
import { loadFeaturesAtPoints, type LoadOptions, type LoadStats } from './fgb-points.js';
import type { RangeSource } from './range-source.js';

export { PolygonIndex, type Assignment, type PolygonIndexOptions, type Status } from './assign.js';
export { loadFeaturesAtPoints, searchPoints, treeByteLength, treeLevels, type LoadOptions, type LoadStats, type Point } from './fgb-points.js';
export { parseCsv, parseStopsTxt, readStopsFromZip, type Stop } from './gtfs-stops.js';
export { httpRangeSource, type HttpRangeSourceOptions, type RangeSource } from './range-source.js';

export type AssignOptions = LoadOptions & PolygonIndexOptions & {
  /** NEAR_BORDER below this distance to the edge of the stop's polygon, in metres. Default 25. */
  flagDistanceM?: number;
};

/**
 * Load the polygons containing the stops (3 round trips) and assign every stop.
 * Assignments come back in the order of `stops`.
 */
export async function assignStops(
  source: RangeSource,
  stops: Array<{ id: string; lon: number; lat: number }>,
  options: AssignOptions = {},
): Promise<{ assignments: Assignment[]; polygons: number; stats: LoadStats & { assignMs: number } }> {
  const { features, stats } = await loadFeaturesAtPoints(source, stops.map(s => [s.lon, s.lat]), options);
  const t = performance.now();
  const index = new PolygonIndex(features, options);
  const assignments = stops.map(s => index.assign(s, options.flagDistanceM ?? 25));
  return { assignments, polygons: index.size, stats: { ...stats, assignMs: performance.now() - t } };
}
