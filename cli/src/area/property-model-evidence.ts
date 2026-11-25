import type { Segment } from '../build/room-faces.js';
import { geoJsonToJsts, type JstsGeometry } from '../geo/geojson-to-jsts.js';
import { parseCsvText } from '../utils/csv-text.js';
import { projectGeometryPath } from './project-input.js';
import { inspectRoomEvidence, metricPosition, needsRoomBoundary, readPropertyPolygon, roomBoundaryTables,
  type ModelFeature } from './property-room-evidence.js';

type ReadText = (path: string) => string | null | undefined | Promise<string | null | undefined>;
const surfaceTables = ['slab', 'structure_slab', 'roof'] as const;
type SurfaceTable = typeof surfaceTables[number];
type Table = SurfaceTable | 'opening' | 'space' | typeof roomBoundaryTables[number];
type ObjectRef = { level: string; table: Table; id: string };
type Diagnostic = { code: string; path: string; id?: string };
type OpeningStatus = 'hosted-cut' | 'already-in-host-hole' | 'partially-in-host' |
  'outside-host' | 'unresolved-host' | 'cross-level-shaft' | 'missing-geometry' | 'geometry-error';
const scales = new Map(Object.entries({ m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 }));
const epsilonM2 = 0.000001;

function indexUnique<T>(values: T[], idOf: (value: T) => unknown, path: string, diagnostics: Diagnostic[]) {
  const index = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const id = idOf(value);
    if (typeof id !== 'string' || !id.trim()) diagnostics.push({ code: 'missing-id', path });
    else if (index.has(id)) {
      duplicates.add(id);
      diagnostics.push({ code: 'duplicate-id', path, id });
    } else index.set(id, value);
  }
  for (const id of duplicates) index.delete(id);
  return { index, duplicates };
}

/** Inventory horizontal projections for review without adopting a property area or inferring ownership. */
export async function inspectPropertyModelEvidence(read: ReadText) {
  const diagnostics: Diagnostic[] = [];
  const metadata = JSON.parse((await read('project_metadata.json')) ?? 'null');
  const inputUnits = metadata?.units ?? 'm';
  const scale = scales.get(inputUnits);
  if (String(metadata?.format_version) !== '2' || scale === undefined)
    throw new Error('模型取证需要 BIMDown 格式版本 2 及受支持的坐标单位。');
  const modelRevision = typeof metadata.engineering_revision === 'string' && metadata.engineering_revision.trim()
    ? metadata.engineering_revision : null;
  if (!modelRevision) diagnostics.push({ code: 'missing-model-revision', path: 'project_metadata.json' });
  else {
    const path = 'engineering_evidence.json';
    const text = await read(path);
    if (text) {
      try {
        const evidence = JSON.parse(text);
        if (evidence?.version !== 1 || evidence.modelRevision !== modelRevision)
          diagnostics.push({ code: 'engineering-revision-mismatch', path });
      } catch { diagnostics.push({ code: 'invalid-engineering-evidence', path }); }
    }
  }
  const levelPath = 'global/level.csv';
  const levelsText = await read(levelPath);
  if (!levelsText) throw new Error('模型缺少 global/level.csv，无法按标高层归集证据。');
  const levels = indexUnique(parseCsvText(levelsText).rows, row => row.id, levelPath, diagnostics).index;
  if (!levels.size) throw new Error('global/level.csv 中没有可唯一定位的标高层。');

  async function load(level: string, table: Table, issues: Diagnostic[]) {
    const path = projectGeometryPath({ level, table });
    const csv = path.replace(/\.geojson$/, '.csv');
    const [values, geometryText] = await Promise.all([read(csv), read(path)]);
    const rows = indexUnique(values ? parseCsvText(values).rows : [], row => row.id, csv, issues);
    let features: ModelFeature[] = [];
    let invalidGeometryFile = false;
    if (geometryText) {
      try {
        const collection = JSON.parse(geometryText);
        if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error();
        features = collection.features;
      } catch {
        invalidGeometryFile = true;
        issues.push({ code: 'invalid-feature-collection', path });
      }
    }
    const shapes = indexUnique(features, shape => shape?.properties?.id, path, issues);
    return { path, csv, rows, shapes, invalidGeometryFile };
  }

  let globalWalls: ReturnType<typeof loadWalls> | undefined;
  const datum = (id: string | undefined) => {
    const value = id ? levels.get(id)?.elevation : undefined;
    return value?.trim() ? Number(value) * scale : NaN;
  };
  async function loadWalls(scope: string, issues: Diagnostic[]) {
    const layers = await Promise.all(roomBoundaryTables.map(async table => {
      const tableIssues: Diagnostic[] = [];
      const layer = await load(scope, table, tableIssues);
      return { ...layer, tableIssues };
    }));
    for (const layer of layers) issues.push(...layer.tableIssues);
    return layers.flatMap(layer => [...layer.shapes.index].flatMap(([id, feature]) => {
      const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | undefined;
      const coordinates = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)
        ? geometry.coordinates.map(point => metricPosition(point, scale!)) : [];
      if (coordinates.length < 2 || coordinates.some(point => point === null)) {
        issues.push({ code: 'invalid-room-boundary-line', path: layer.path, id });
        return [];
      }
      const points = coordinates.filter(point => point !== null);
      const segments = points.slice(1).flatMap(([endX, endY], i): Segment[] => {
        const [startX, startY] = points[i];
        return startX === endX && startY === endY ? [] : [{ startX, startY, endX, endY, id: `${layer.path}/${id}` }];
      });
      const row = layer.rows.index.get(id);
      if (!segments.length) return [];
      const base = datum(row?.base_level_id || row?.level_id) + Number(feature.properties?.base_offset ?? row?.base_offset ?? 0) * scale!;
      const top = row?.top_level_id
        ? datum(row.top_level_id) + Number(feature.properties?.top_offset ?? row.top_offset ?? 0) * scale!
        : base + Number(feature.properties?.height ?? row?.height) * scale!;
      return [{ path: layer.path, id, segments, base, top }];
    }));
  }

  const scans = [];
  for (const [id, row] of levels) {
    const issues: Diagnostic[] = [];
    const elevation = Number(row.elevation) * scale;
    const elevationM = row.elevation?.trim() && Number.isFinite(elevation) ? elevation : null;
    if (elevationM === null) issues.push({ code: 'invalid-elevation', path: levelPath, id });
    const name = row.name?.trim() || id;
    const roleHint = row.usage?.trim() || (/屋顶|机房顶|roof/i.test(name) ? 'roof-datum-by-name' : null);
    const surfaces: { ref: ObjectRef; path: string; modelFunction: string | null; polygon: JstsGeometry;
      shell: JstsGeometry; cuts: JstsGeometry[] }[] = [];
    const hostTableCounts = new Map<string, number>();
    for (const table of surfaceTables) {
      const { path, csv, rows, shapes } = await load(id, table, issues);
      for (const key of new Set([...rows.index.keys(), ...rows.duplicates, ...shapes.index.keys(), ...shapes.duplicates]))
        hostTableCounts.set(key, (hostTableCounts.get(key) ?? 0) + 1);
      for (const surfaceId of rows.index.keys()) {
        if (!shapes.index.has(surfaceId) && !shapes.duplicates.has(surfaceId))
          issues.push({ code: 'missing-surface-polygon', path, id: surfaceId });
      }
      for (const [surfaceId, shape] of shapes.index) {
        if (rows.duplicates.has(surfaceId)) continue;
        const source = rows.index.get(surfaceId);
        if (!source) issues.push({ code: 'missing-surface-row', path: csv, id: surfaceId });
        try {
          const { polygon, outline } = readPropertyPolygon(shape.geometry, scale);
          surfaces.push({ ref: { level: id, table, id: surfaceId }, path, modelFunction: source?.function || null,
            polygon, shell: geoJsonToJsts({ type: 'Polygon', coordinates: outline.coordinates.slice(0, 1) })!, cuts: [] });
        } catch { issues.push({ code: 'invalid-surface-polygon', path, id: surfaceId }); }
      }
    }
    const openings = await load(id, 'opening', issues);
    const openingItems = [];
    const openingIds = new Set([...openings.rows.index.keys(), ...openings.shapes.index.keys()]);
    for (const openingId of openingIds) {
      if (openings.rows.duplicates.has(openingId) || openings.shapes.duplicates.has(openingId)) continue;
      const source = openings.rows.index.get(openingId);
      const shape = openings.shapes.index.get(openingId);
      const hostId = source?.host_id || null;
      const hostTableCount = hostId ? hostTableCounts.get(hostId) ?? 0 : 0;
      if (!shape && !hostTableCount && !source?.top_level_id) continue;
      const host = hostTableCount === 1 ? surfaces.find(surface => surface.ref.id === hostId) : undefined;
      const item = { ref: { level: id, table: 'opening', id: openingId } as const, path: openings.path,
        hostId, host: host?.ref ?? null };
      let status: OpeningStatus;
      let cutM2: number | null = null;
      if (source?.top_level_id) status = 'cross-level-shaft';
      else if (!host) status = 'unresolved-host';
      else if (!shape) status = 'missing-geometry';
      else {
        try {
          const { polygon } = readPropertyPolygon(shape.geometry, scale);
          const queryArea = polygon.getArea();
          const inShell = polygon.intersection(host.shell).getArea();
          const overlap = polygon.intersection(host.polygon);
          if (!Number.isFinite(inShell) || !Number.isFinite(overlap.getArea())) throw new Error();
          cutM2 = overlap.getArea();
          if (cutM2 > epsilonM2) host.cuts.push(overlap);
          status = inShell <= epsilonM2 ? 'outside-host'
            : queryArea - inShell > epsilonM2 ? 'partially-in-host'
              : cutM2 <= epsilonM2 ? 'already-in-host-hole'
                : queryArea - cutM2 > epsilonM2 ? 'partially-in-host' : 'hosted-cut';
        } catch { status = 'geometry-error'; }
      }
      if (status !== 'hosted-cut' && status !== 'already-in-host-hole')
        issues.push({ code: status, path: openings.path, id: openingId });
      openingItems.push({ ...item, status, cutM2, topLevelId: source?.top_level_id || null });
    }
    let projectedAreaM2: number | null = null;
    let netProjectionM2: number | null = null;
    if (surfaces.length) {
      try {
        const union = (polygons: JstsGeometry[]) => polygons.reduce((a, b) => a.union(b));
        projectedAreaM2 = union(surfaces.map(surface => surface.polygon)).getArea();
        netProjectionM2 = union(surfaces.map(surface =>
          surface.cuts.length ? surface.polygon.difference(union(surface.cuts)) : surface.polygon)).getArea();
        if (!Number.isFinite(projectedAreaM2) || !Number.isFinite(netProjectionM2)) throw new Error();
      } catch {
        projectedAreaM2 = netProjectionM2 = null;
        issues.push({ code: 'surface-overlay-failed', path: id });
      }
    } else issues.push({ code: 'no-surface-polygons', path: id });

    const roomLayer = await load(id, 'space', issues);
    let walls: Awaited<ReturnType<typeof loadWalls>> = [];
    if (needsRoomBoundary(roomLayer)) {
      walls = await loadWalls(id, issues);
      const global = await (globalWalls ??= loadWalls('global', diagnostics).then(walls => walls.filter(wall => {
        const scoped = Number.isFinite(wall.base) && Number.isFinite(wall.top) && wall.top > wall.base;
        if (!scoped) diagnostics.push({ code: 'unscoped-global-wall', path: wall.path, id: wall.id });
        return scoped;
      })));
      if (elevationM !== null) walls.push(...global.filter(wall => wall.base <= elevationM + 0.01 && wall.top > elevationM + 0.01));
    }
    const rooms = inspectRoomEvidence(id, roomLayer, scale, {
      segments: walls.flatMap(wall => wall.segments), sourceFiles: [...new Set(walls.map(wall => wall.path))],
    });
    if (!rooms.rowCount) issues.push({ code: 'no-space-rows', path: roomLayer.csv });
    if (!rooms.outlineIds.length && !rooms.derivedOutlineIds.length) issues.push({ code: 'no-space-outlines', path: roomLayer.path });
    for (const orphanId of rooms.orphanOutlineIds) issues.push({ code: 'orphan-room-outline', path: roomLayer.path, id: orphanId });
    scans.push({ id, name, elevationM, roleHint, scopeStatus: 'unreviewed' as const, projectedAreaM2, netProjectionM2,
      surfaces: surfaces.map(surface => ({ ...surface.ref, path: surface.path, modelFunction: surface.modelFunction,
        polygonAreaM2: surface.polygon.getArea() })),
      openings: openingItems, rooms, diagnostics: issues });
  }
  const idsByElevation = new Map<number, string[]>();
  for (const level of scans) {
    if (level.elevationM === null) continue;
    const ids = idsByElevation.get(level.elevationM) ?? [];
    ids.push(level.id);
    idsByElevation.set(level.elevationM, ids);
  }
  return { version: 1, modelRevision, source: 'BIMDown format 2 model geometry', inputUnits, unit: 'm2',
    status: 'candidate-only' as const, diagnostics, levels: scans.map(level => ({ ...level,
      sameElevationLevelIds: level.elevationM === null ? []
        : idsByElevation.get(level.elevationM)!.filter(id => id !== level.id) })) };
}

export type PropertyModelEvidence = Awaited<ReturnType<typeof inspectPropertyModelEvidence>>;
