import { validateRule, type EngineeringRule } from './core/index.js';
import { executeSpaceOverlap } from './core/overlap.js';
import { geoJsonToJsts } from './geo/geojson-to-jsts.js';
import { type readCheckRooms } from './check-model.js';
import { objectId, parseEvidence, TOOL_EVIDENCE_PATH } from './tool-evidence.js';
import type { Blocker } from './pal-readiness.js';

export const OVERLAP = 'space.projected-overlap-area';
export type SpaceOverlapRule = Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> &
  { kind: 'space-projection-exclusion' };
const prohibited = ['bedroom', 'living', 'kitchen', 'dining'] as const;
type SpaceUse = 'bathroom' | 'other' | typeof prohibited[number];
type Pair = { upper: string; lower: string; frame: string; source: string; lowerInventoryConfirmed: true };
type FootprintRecord = { object: { scope: string; table: 'space'; id: string }; use: SpaceUse;
  source: string; frame: string; confirmed: boolean };
const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const allowedUses = new Set<string>(['bathroom', 'other', ...prohibited]);

export function validateSpaceOverlapRule(rule: SpaceOverlapRule) {
  if (rule?.kind !== 'space-projection-exclusion') throw new Error('缺少跨层空间投影规则。');
  validateRule({ ...rule, concept: OVERLAP, unit: 'm2', operator: '<=', threshold: 0 });
}

function readRelations(value: unknown) {
  const relations = value as { levelPairs?: Pair[]; footprints?: FootprintRecord[] } | undefined;
  if (!Array.isArray(relations?.levelPairs) || !Array.isArray(relations.footprints) ||
      relations.levelPairs.length + relations.footprints.length > 100_000)
    throw new Error('缺少已确认的上下层配对、坐标系或空间用途记录。');
  const pairs = new Map<string, Pair>();
  for (const pair of relations.levelPairs) {
    if (!pair || ![pair.upper, pair.lower, pair.frame, pair.source].every(present) || pair.upper === pair.lower ||
        pair.lowerInventoryConfirmed !== true || pairs.has(pair.upper))
      throw new Error('上下层配对重复、缺少坐标基准或下层清单未确认。');
    pairs.set(pair.upper, pair);
  }
  const footprints = new Map<string, FootprintRecord>();
  for (const fact of relations.footprints) {
    if (!fact || fact.object?.table !== 'space' || ![fact.object.scope, fact.object.id, fact.frame, fact.source].every(present) ||
        !allowedUses.has(fact.use) || typeof fact.confirmed !== 'boolean')
      throw new Error('空间轮廓记录缺少作用域、用途或确认依据。');
    const key = objectId(fact.object);
    if (footprints.has(key)) throw new Error('存在重复的空间用途或轮廓确认。');
    footprints.set(key, fact);
  }
  return { pairs, footprints };
}

type RoomInventory = Awaited<ReturnType<typeof readCheckRooms>>;
type Floor = RoomInventory['data'][number];
function ringsFor(level: Floor, id: string) {
  const features = level.byId.get(id)?.features;
  const feature = features?.length === 1 ? features[0] : undefined;
  const rings = feature?.geometry?.coordinates;
  if (feature?.geometry?.type !== 'Polygon' || feature.properties?.redundant === true || !Array.isArray(rings) ||
      rings.length === 0 || rings.some(ring => !Array.isArray(ring) || ring.length < 4 ||
        ring.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) ||
        ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) return undefined;
  const coordinates = rings as [number, number][][];
  try {
    return geoJsonToJsts({ type: 'Polygon', coordinates })?.isValid() ? coordinates : undefined;
  } catch { return undefined; }
}

function footprintMatchesFrame(level: Floor, id: string, frame: string) {
  const features = level.byId.get(id)?.features;
  const recorded = features?.length === 1 ? features[0].properties?.frame : undefined;
  return recorded === undefined || recorded === frame;
}

/** A pass requires the confirmed inventory for the paired lower storey. */
export function checkSpaceOverlap(rule: SpaceOverlapRule, inventory: RoomInventory, text: string | null,
  projectRevision: string | undefined, modelVersion: string, unit?: string) {
  validateSpaceOverlapRule(rule);
  const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, modelVersion, tool: 'space-overlap@1' };
  if (!inventory.rooms.length) return [{ ...base, object: null, name: undefined, status: 'indeterminate' as const, reason: '模型没有房间记录。' }];
  let evidence: ReturnType<typeof parseEvidence> | undefined;
  let relations: ReturnType<typeof readRelations> | undefined;
  let error: string | undefined;
  try {
    evidence = parseEvidence(text, projectRevision);
    relations = readRelations(evidence.spaceRelations);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : `${TOOL_EVIDENCE_PATH} 无法读取。`;
  }
  const levels = new Map(inventory.data.map(floor => [floor.level.id, floor]));
  let attemptedPairs = 0;
  return inventory.rooms.map(({ scope, id, name }) => {
    const object = { scope, table: 'space' as const, id };
    const row = { ...base, object, name };
    const pending = (reason: string, blocker: Blocker) => ({ ...row, status: 'indeterminate' as const, reason, blocker });
    if (!evidence) return pending(error ?? '缺少工程证据。', 'invalid-evidence');
    const key = objectId(object);
    const scopeKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
    const decision = evidence.applicability.get(scopeKey);
    if (!rule.reviewed || !decision || evidence.duplicate.has(scopeKey))
      return pending('缺少本条款和房间的适用性确认。', evidence.duplicate.has(scopeKey) ? 'input-conflict' : 'confirm-applicability');
    if (decision.decision === 'does-not-apply')
      return { ...row, status: 'not-applicable' as const, applicabilitySource: decision.source };
    if (!relations) return pending(error ?? '缺少上下层关系。', 'confirm-space-relations');
    if (unit !== 'm' && unit !== 'mm') return pending('跨层投影需要 m 或 mm 的项目坐标单位。', 'execution-input');
    const pair = relations.pairs.get(scope);
    const first = relations.footprints.get(key);
    const above = levels.get(scope)!;
    const below = pair && levels.get(pair.lower);
    const upperRings = ringsFor(above, id);
    if (!pair || !below?.raw[0] || below.level.elevation === undefined || above.level.elevation === undefined ||
        below.level.elevation >= above.level.elevation || !below.byId.size)
      return pending('缺少已确认、标高有序的上下层配对或下层房间清单。', 'confirm-space-relations');
    if (!above.raw[0] || !above.csvIds.has(id) || !first?.confirmed || first.use !== 'bathroom' || first.frame !== pair.frame)
      return pending('上层卫生间缺少匹配坐标系的用途确认。', 'confirm-space-relations');
    if (!footprintMatchesFrame(above, id, pair.frame))
      return pending('上层轮廓导出的坐标基准与复核配对不一致。', 'input-conflict');
    if (!upperRings) return pending('上层卫生间缺少有效封闭轮廓。', 'missing-outline');
    const matches = [];
    let missing: { reason: string; blocker: Blocker } | undefined;
    for (const lowerId of below.byId.keys()) {
      if (++attemptedPairs > 20_000) throw new Error('跨层房间组合超过 20,000 项，请缩小核查范围。');
      const lowerObject = { scope: pair.lower, table: 'space' as const, id: lowerId };
      const second = relations.footprints.get(objectId(lowerObject));
      if (!below.csvIds.has(lowerId) || !second?.confirmed || second.frame !== pair.frame) {
        missing ??= { reason: `下层房间 ${lowerId} 的用途或坐标基准待确认。`, blocker: 'confirm-space-relations' };
        continue;
      }
      if (!(prohibited as readonly string[]).includes(second.use)) continue;
      if (!footprintMatchesFrame(below, lowerId, pair.frame)) {
        missing ??= { reason: `下层房间 ${lowerId} 的轮廓坐标基准与复核配对不一致。`, blocker: 'input-conflict' };
        continue;
      }
      const lowerRings = ringsFor(below, lowerId);
      if (!lowerRings) {
        missing ??= { reason: `下层房间 ${lowerId} 缺少有效封闭轮廓。`, blocker: 'missing-outline' };
        continue;
      }
      const result = executeSpaceOverlap({ tool: 'space-overlap',
        rule: { ...rule, concept: OVERLAP, unit: 'm2', operator: '<=', threshold: 0 },
        modelVersion, frame: pair.frame, unit, footprints: [
          { object, source: first.source, confirmed: true, rings: upperRings },
          { object: lowerObject, source: second.source, confirmed: true, rings: lowerRings },
        ] });
      if (result.status === 'indeterminate') missing ??= { reason: result.diagnostic.reason, blocker: 'execution-input' };
      else matches.push({ status: result.status, lowerObject, evidence: result.evidence });
    }
    const violations = matches.filter(match => match.status === 'fail');
    if (!violations.length && missing) return pending(missing.reason, missing.blocker);
    return { ...row, status: violations.length ? 'fail' as const : 'pass' as const,
      overlap: { pair, applicabilitySource: decision.source, upperSource: first.source,
        checked: matches.length, lowerInventory: below.byId.size, violations, ...(missing && { remainingGap: missing.reason }) } };
  });
}
