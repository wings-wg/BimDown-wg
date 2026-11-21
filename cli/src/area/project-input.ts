import { calculateAreas, type AreaInput, type AreaPart } from './index.js';
import type { AreaFeatures } from './factor.js';

export interface ProjectAreaConfig extends Omit<AreaInput, 'parts'> {
  /** Explicit measurement selections: do not equate Room outlines with title boundaries. */
  selections: {
    id: string;
    owner: string;
    level: string;
    table: string;
    elementId: string;
    kind: AreaPart['kind'];
    factor: AreaPart['factor'];
    features?: AreaFeatures;
    source: string;
  }[];
  /** Supplementary reviewed wall/other areas not represented by polygons. */
  parts?: AreaPart[];
}
const scales = new Map(Object.entries({ m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 }));
export function projectGeometryPath({ level, table }: Pick<ProjectAreaConfig['selections'][number], 'level' | 'table'>) {
  for (const segment of [level, table]) {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || /[\\/:]/.test(segment))
      throw new Error('Unsafe project path: expected a project-relative level and table name');
  }
  return `${level}/${table}.geojson`;
}

/** Bind explicitly selected model evidence, then run the shared area calculation. */
export function calculateProjectAreasFromText(
  text: (relative: string) => string | undefined,
  config: ProjectAreaConfig,
) {
  const metadata = text('project_metadata.json');
  if (!metadata) throw new Error('Missing project_metadata.json');
  const meta = JSON.parse(metadata);
  if (String(meta.format_version) !== '2') throw new Error('Area adapter requires GeoJSON format_version 2');
  const scale = scales.get(meta.units);
  if (!scale) throw new Error(`Unsupported or missing project units: ${meta.units}`);
  const evidenceText = text('area_features.json');
  const evidence = evidenceText ? JSON.parse(evidenceText) : undefined;
  const parts: AreaPart[] = [...(config.parts ?? [])];
  const used = new Set<string>();
  const origins: object[] = [];
  for (const selection of config.selections) {
    const key = `${selection.level}/${selection.table}/${selection.elementId}`;
    if (used.has(key)) throw new Error(`Duplicate measurement selection: ${key}`);
    used.add(key);
    const relative = projectGeometryPath(selection);
    const geometryText = text(relative);
    if (!geometryText) throw new Error(`Missing geometry: ${relative}`);
    const fc = JSON.parse(geometryText);
    const matches = fc.features?.filter((f: any) => String(f.properties?.id) === selection.elementId) ?? [];
    if (matches.length !== 1 || matches[0].geometry?.type !== 'Polygon') throw new Error(`Expected unique Polygon: ${key}`);
    const feature = matches[0];
    if (feature.properties?.redundant === true) throw new Error(`Room duplicates another measurement outline: ${key}`);
    // Explicit adapter overrides are reviewed; only confirmed booleans from Revit are imported.
    const room = evidence?.rooms?.find((r: any) => r.id === selection.elementId);
    const features = selection.features ? { ...selection.features } : undefined;
    if (features && room) for (const name of ['covered', 'enclosed', 'connectedToIndoor'] as const)
      if (features[name] === undefined && typeof room[name] === 'boolean') features[name] = room[name];
    const rings = feature.geometry.coordinates.map((ring: number[][]) => ring.map(p => {
      if (p.length < 2 || p.some(v => !Number.isFinite(v))) throw new Error(`Invalid coordinate: ${key}`);
      return [p[0] * scale, p[1] * scale];
    }));
    parts.push({ id: selection.id, owner: selection.owner, kind: selection.kind, factor: selection.factor,
      source: selection.source, features, rings });
    origins.push({ partId: selection.id, geometry: relative, elementId: selection.elementId,
      featureEvidence: room ?? null, inputUnits: meta.units });
  }
  const result = calculateAreas({ ...config, parts });
  return { ...result, modelSources: origins,
    measurementNote: 'Selected XY outlines are reviewer-approved measurement boundaries; no automatic title or wall-boundary inference.' };
}
