import { deriveRooms, type Face, type RoomSeed, type Segment } from '../build/room-faces.js';
import { simpleRoomBoundary } from '../build/room-ring.js';
import { geoJsonToJsts, type JstsGeometry } from '../geo/geojson-to-jsts.js';

type Position = [number, number];
type Polygon = { type: 'Polygon'; coordinates: Position[][] };
export type ModelFeature = { properties?: Record<string, unknown>; geometry?: unknown };
export const roomBoundaryTables = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'] as const;
type RoomBasis = 'wall-centerline' | 'revit-room-finish' | 'unknown-saved-boundary';

export function metricPosition(point: unknown, scale: number): Position | null {
  if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') return null;
  const x = point[0] * scale, y = point[1] * scale;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function readPropertyPolygon(input: unknown, scale: number) {
  const geometry = input as { type?: unknown; coordinates?: unknown };
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) throw new Error('Expected Polygon');
  const coordinates = geometry.coordinates.map((ring: unknown) => {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error('Invalid ring');
    return ring.map((point: unknown): Position => {
      const metric = metricPosition(point, scale);
      if (!metric) throw new Error('Invalid position');
      return metric;
    });
  });
  const outline: Polygon = { type: 'Polygon', coordinates };
  const polygon = geoJsonToJsts(outline);
  if (!polygon?.isValid() || !Number.isFinite(polygon.getArea()) || polygon.getArea() <= 0)
    throw new Error('Invalid polygon');
  return { polygon, outline };
}

export function roomOutlinesOverlap(left: JstsGeometry, right: JstsGeometry) {
  return left.intersects(right) && left.intersection(right).getArea() > 1e-6;
}

function hasSeedCoordinate(value: string | undefined): value is string {
  return typeof value === 'string' && !!value.trim() && Number.isFinite(Number(value));
}

type RoomSource = {
  csv: string;
  path: string;
  rows: { index: Map<string, Record<string, string>>; duplicates: Set<string> };
  shapes: { index: Map<string, ModelFeature>; duplicates: Set<string> };
  invalidGeometryFile: boolean;
};
type Boundary = { segments: Segment[]; sourceFiles: string[] };

export function needsRoomBoundary(layer: RoomSource) {
  if (layer.invalidGeometryFile) return false;
  return [...layer.rows.index.keys()].some(id => !layer.shapes.index.has(id) && !layer.shapes.duplicates.has(id));
}

/** Match saved polygons or wall-centre faces to level-scoped room seeds. All areas are candidates. */
export function inspectRoomEvidence(level: string, layer: RoomSource, scale: number, boundary: Boundary) {
  const seeds = new Map<string, RoomSeed>();
  for (const [id, row] of layer.rows.index) {
    if (!hasSeedCoordinate(row.x) || !hasSeedCoordinate(row.y)) continue;
    const xy = metricPosition([Number(row.x), Number(row.y)], scale);
    if (xy) seeds.set(id, { id, x: xy[0], y: xy[1] });
  }
  const derived = boundary.segments.length && needsRoomBoundary(layer)
    ? deriveRooms(level, boundary.segments, [...seeds.values()]) : undefined;
  const sharedSeeds = new Set(derived?.roomIssues.filter(issue => issue.kind === 'shared').flatMap(issue => issue.spaceIds));
  const faces = new Map<Face, ReturnType<typeof readPropertyPolygon>>();
  for (const face of derived?.faces ?? []) {
    if (face.signedArea <= 0) continue;
    const points = simpleRoomBoundary(face.polygon);
    if (!points) continue;
    const ring = points.map(({ x, y }): Position => [x, y]);
    try { faces.set(face, readPropertyPolygon({ type: 'Polygon', coordinates: [[...ring, ring[0]]] }, 1)); }
    catch { /* The matched seed retains an invalid-outline diagnostic. */ }
  }
  const nestedFaces = new Set([...faces].filter(([, outer]) => [...faces.values()].some(inner =>
    inner.polygon.getArea() + 1e-6 < outer.polygon.getArea() && outer.polygon.contains(inner.polygon))).map(([face]) => face));
  const unresolved = new Map<string, string>();
  const candidates = new Map<string, ReturnType<typeof readPropertyPolygon> & { basis: RoomBasis; source: 'stored' | 'derived' }>();
  for (const id of layer.rows.index.keys()) {
    const seed = seeds.get(id);
    const saved = layer.shapes.index.get(id);
    if (layer.invalidGeometryFile || layer.shapes.duplicates.has(id) || saved?.properties?.redundant === true) {
      unresolved.set(id, 'invalid-or-redundant-saved-outline');
      continue;
    }
    if (saved) {
      try {
        const geometry = readPropertyPolygon(saved.geometry, scale);
        if (seed && !geometry.polygon.contains(geoJsonToJsts({ type: 'Point', coordinates: [seed.x, seed.y] })!)) {
          unresolved.set(id, 'seed-outside-saved-outline');
          continue;
        }
        const basis = saved.properties?.boundary_basis;
        candidates.set(id, { ...geometry, source: 'stored',
          basis: basis === 'wall-centerline' || basis === 'revit-room-finish' ? basis : 'unknown-saved-boundary' });
      } catch { unresolved.set(id, 'invalid-or-redundant-saved-outline'); }
      continue;
    }
    const face = derived?.matched.get(id);
    const geometry = face ? faces.get(face) : undefined;
    if (!seed) unresolved.set(id, 'invalid-room-seed');
    else if (!boundary.segments.length) unresolved.set(id, 'no-room-boundary-walls');
    else if (sharedSeeds.has(id)) unresolved.set(id, 'shared-room-face');
    else if (!face) unresolved.set(id, 'unbounded-room');
    else if (nestedFaces.has(face)) unresolved.set(id, 'nested-room-face');
    else if (!geometry || !geometry.polygon.contains(geoJsonToJsts({ type: 'Point', coordinates: [seed.x, seed.y] })!))
      unresolved.set(id, 'invalid-derived-room-outline');
    else candidates.set(id, { ...geometry, source: 'derived', basis: 'wall-centerline' });
  }

  // A saved polygon may overlap an unrelated saved or derived room. Withhold the area from both.
  const previous: { id: string; polygon: JstsGeometry }[] = [];
  for (const [id, { polygon }] of candidates) {
    for (const other of previous) {
      try {
        if (!roomOutlinesOverlap(polygon, other.polygon)) continue;
        unresolved.set(id, 'overlapping-room-outlines');
        unresolved.set(other.id, 'overlapping-room-outlines');
      } catch {
        unresolved.set(id, 'room-overlap-check-failed');
        unresolved.set(other.id, 'room-overlap-check-failed');
      }
    }
    previous.push({ id, polygon });
  }
  const items = [...layer.rows.index].map(([id, row]) => {
    const seed = seeds.get(id);
    const issue = unresolved.get(id) ?? null;
    const candidate = issue ? undefined : candidates.get(id);
    return { id, name: row.name || id, number: row.number || null, seedM: seed ? [seed.x, seed.y] : null,
      status: candidate?.source ?? 'needs-review' as const, basis: candidate?.basis ?? null,
      areaM2: candidate?.polygon.getArea() ?? null, outline: candidate?.outline ?? null, issue,
      path: candidate?.source === 'stored' ? layer.path : layer.csv };
  });
  return { rowCount: layer.rows.index.size, sourceFiles: boundary.sourceFiles,
    outlineIds: items.filter(item => item.status === 'stored').map(item => item.id),
    derivedOutlineIds: items.filter(item => item.status === 'derived').map(item => item.id),
    needsReviewCount: items.filter(item => item.status === 'needs-review').length,
    orphanOutlineIds: [...layer.shapes.index.keys()].filter(id => !layer.rows.index.has(id) && !layer.rows.duplicates.has(id)),
    items };
}
