import { polygonArea } from '../area/index.js';
import { geoJsonToJsts, type JstsGeometry } from '../geo/index.js';
import { validateRule, type EngineeringDatum, type EngineeringRule } from './index.js';

interface SpaceFootprint {
  object: EngineeringDatum['object'];
  source: string;
  confirmed: boolean;
  rings: [number, number][][];
}

export interface SpaceOverlapCase {
  tool: 'space-overlap';
  rule: EngineeringRule;
  modelVersion: string;
  frame: string;
  unit: 'm' | 'mm';
  footprints?: [SpaceFootprint, SpaceFootprint];
}

const hasText = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

function intersectionPolygons(geometry: JstsGeometry): number[][][][] {
  if (geometry.isEmpty()) return [];
  switch (geometry.getGeometryType()) {
    case 'Polygon': {
      const polygon = geometry as JstsGeometry & {
        getNumInteriorRing(): number;
        getInteriorRingN(index: number): JstsGeometry;
      };
      const rings = [polygon.getExteriorRing(), ...Array.from(
        { length: polygon.getNumInteriorRing() }, (_, index) => polygon.getInteriorRingN(index),
      )];
      return [rings.map(ring => ring.getCoordinates().map(({ x, y }) => [x, y]))];
    }
    case 'MultiPolygon':
    case 'GeometryCollection':
      return Array.from({ length: geometry.getNumGeometries() }, (_, index) =>
        intersectionPolygons(geometry.getGeometryN(index))).flat();
    default:
      return [];
  }
}

export function executeSpaceOverlap(plan: SpaceOverlapCase) {
  const { rule, footprints } = plan;
  validateRule(rule);
  const base = { tool: 'space-overlap@1', ruleId: rule.id, ruleVersion: rule.version,
    source: rule.source, applicability: rule.applicability };
  const indeterminate = (status: string, reason: string) =>
    ({ ...base, status: 'indeterminate' as const, diagnostic: { status, reason } });
  if (!rule.reviewed) return indeterminate('clarification-required', 'Candidate rule requires review');
  if (rule.concept !== 'space.projected-overlap-area' || rule.unit !== 'm2' || !['m', 'mm'].includes(plan.unit))
    return indeterminate('unsupported', 'Expected projected overlap area in square metres and coordinates in metres or millimetres');
  if (!hasText(plan.frame) || !hasText(plan.modelVersion) || !Array.isArray(footprints) || footprints.length !== 2 ||
      footprints.some(item => !item || !Array.isArray(item.rings) || !hasText(item.source) ||
        ![item.object?.scope, item.object?.table, item.object?.id].every(hasText)))
    return indeterminate('missing-data', 'Two sourced footprints, scoped IDs, model version and a shared coordinate frame are required');
  if (footprints.some(item => item.confirmed !== true) || footprints[0].object.scope === footprints[1].object.scope)
    return indeterminate('clarification-required', 'Confirm both footprints in the same coordinate frame on distinct level scopes');

  try {
    const divisor = plan.unit === 'mm' ? 1000 : 1;
    const [first, second] = footprints.map(item => {
      const area = polygonArea(item.rings) / divisor ** 2;
      const coordinates = item.rings.map(ring => ring.map(([x, y]) => [x / divisor, y / divisor] as [number, number]));
      const geometry = geoJsonToJsts({ type: 'Polygon', coordinates });
      if (!geometry?.isValid() || !Number.isFinite(area)) throw new Error('Expected a valid, finite footprint polygon');
      return { geometry, area };
    });
    const polygons = intersectionPolygons(first.geometry.intersection(second.geometry));
    const area = polygons.reduce((total, rings) => total + polygonArea(rings), 0);
    const tolerance = 0.000001;
    if (!Number.isFinite(area) || area > Math.min(first.area, second.area) + tolerance)
      return indeterminate('verification-failed', 'Intersection must be finite and no larger than either footprint');
    const passed = rule.operator === '>=' ? area >= rule.threshold : area <= rule.threshold;
    return { ...base, status: passed ? 'pass' as const : 'fail' as const,
      evidence: { modelVersion: plan.modelVersion, frame: plan.frame, inputUnit: plan.unit, footprints,
        footprintAreas: [first.area, second.area], intersection: { type: 'MultiPolygon' as const, coordinates: polygons },
        area, unit: rule.unit, operator: rule.operator, threshold: rule.threshold, verificationTolerance: tolerance } };
  } catch (error) {
    return indeterminate('geometry-error', (error as Error).message);
  }
}
