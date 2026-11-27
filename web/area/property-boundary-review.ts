import { readPropertyPolygon, roomOutlinesOverlap } from './core/property-room-evidence.js';
import type { PropertyModelEvidence } from './core/property-model-evidence.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import { geoJsonToJsts } from '../check/geo/geojson-to-jsts.js';
import { isPropertyRoomUse, type PropertyRoomUse } from './property-room-use.js';

export const PROPERTY_BOUNDARY_REVIEW_PATH = 'property-boundary-review.json';
export type BoundaryLevel = PropertyModelEvidence['levels'][number];
type Room = BoundaryLevel['rooms']['items'][number];
type Polygon = NonNullable<Room['outline']>;
export type ReviewDecision = 'keep' | 'adjust' | 'defer';
type Group = { kind: 'unit' | 'common' | 'excluded' | 'unassigned'; id: string };
export type BoundaryRecord = {
  level: string;
  roomId: string;
  modelRevision: string | null;
  snapshot: string;
  group: Group;
  decision: ReviewDecision;
  source: string;
  original: { basis: Room['basis']; path: string; boundaryFiles: string[]; outline: Polygon | null; areaM2: number | null };
  reviewed: { outline: Polygon; areaM2: number } | null;
  propertyUse?: PropertyRoomUse;
};
export type BoundaryReviewFile = {
  format: 'bimdown.property-boundary-review';
  version: 1;
  coordinateUnit: 'm';
  records: BoundaryRecord[];
};
export type BoundaryScope = Awaited<ReturnType<typeof makeBoundaryScope>>;

export async function makeBoundaryScope(evidence: PropertyModelEvidence, level: BoundaryLevel, config?: ProjectAreaConfig) {
  const nodes = new Map(config?.nodes.map(node => [node.id, node.type]));
  const selected = new Map<string, ProjectAreaConfig['selections'][number]>();
  const duplicates = new Set<string>();
  for (const item of config?.selections ?? []) {
    if (item.level !== level.id || item.table !== 'space') continue;
    if (selected.has(item.elementId)) duplicates.add(item.elementId);
    selected.set(item.elementId, item);
  }
  const common = new Set(config?.commonRoomDrafts?.filter(item => item.level === level.id).map(item => item.elementId));
  const rooms = level.rooms.items.map(room => {
    const selection = selected.get(room.id);
    const type = selection ? nodes.get(selection.owner) : undefined;
    let group: Group = { kind: 'unassigned', id: '' };
    if (!duplicates.has(room.id)) {
      if (selection?.kind === 'excluded' || type === 'excluded') group = { kind: 'excluded', id: selection?.owner ?? '' };
      else if (selection?.kind === 'common' && type === 'pool' || (!selection && common.has(room.id)))
        group = { kind: 'common', id: selection?.owner ?? '' };
      else if (type === 'unit' && selection?.kind !== 'common') group = { kind: 'unit', id: selection!.owner };
    }
    return { ...room, group };
  });
  const snapshotInput = JSON.stringify([evidence.modelRevision, evidence.inputUnits, level.id, level.elevationM,
    level.rooms.sourceFiles, rooms]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshotInput));
  const snapshot = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return { level, modelRevision: evidence.modelRevision, snapshot, rooms };
}

export function readBoundaryReview(text: string | null): BoundaryReviewFile {
  if (text === null) return { format: 'bimdown.property-boundary-review', version: 1, coordinateUnit: 'm', records: [] };
  const value = JSON.parse(text) as BoundaryReviewFile;
  if (value?.format !== 'bimdown.property-boundary-review' || value.version !== 1 || value.coordinateUnit !== 'm' ||
      !Array.isArray(value.records) || value.records.some(record => !record ||
        typeof record.level !== 'string' || typeof record.roomId !== 'string' || typeof record.snapshot !== 'string' ||
        typeof record.source !== 'string' || !['keep', 'adjust', 'defer'].includes(record.decision) ||
        !record.original || !record.group || (record.decision === 'defer' ? record.reviewed !== null : !record.reviewed) ||
        (record.propertyUse !== undefined && (!record.reviewed || !isPropertyRoomUse(record.propertyUse)))))
    throw new Error('房间边界复核记录格式无效。');
  const keys = new Set(value.records.map(record => JSON.stringify([record.level, record.roomId, record.snapshot])));
  if (keys.size !== value.records.length) throw new Error('同一楼层及版本的房间复核记录重复。');
  for (const record of value.records) if (record.reviewed) {
    const checked = readPropertyPolygon(record.reviewed.outline, 1);
    if (checked.polygon.getArea() !== record.reviewed.areaM2) throw new Error('房间边界记录面积与轮廓不一致。');
  }
  return value;
}

export function activeBoundaryRecords(file: BoundaryReviewFile, scope: BoundaryScope) {
  return new Map(file.records.filter(item => item.level === scope.level.id && item.snapshot === scope.snapshot)
    .map(item => [item.roomId, item]));
}

export function createBoundaryRecord(scope: BoundaryScope, file: BoundaryReviewFile,
  roomId: string, decision: ReviewDecision, source: string, geometryText: string): BoundaryRecord {
  const room = scope.rooms.find(item => item.id === roomId);
  if (!room || !source.trim()) throw new Error('请选择房间并填写复核或调整依据。');
  const original = { basis: room.basis, path: room.path, outline: room.outline, areaM2: room.areaM2,
    boundaryFiles: room.status === 'derived' ? scope.level.rooms.sourceFiles : [] };
  let reviewed: BoundaryRecord['reviewed'] = null;
  if (decision !== 'defer') {
    if (decision === 'keep' && !room.outline) throw new Error('该房间缺少有效候选边界，请补充有效轮廓或保留待核。');
    let geometry: ReturnType<typeof readPropertyPolygon>;
    try { geometry = readPropertyPolygon(decision === 'keep' ? room.outline : JSON.parse(geometryText), 1); }
    catch { throw new Error('请输入有效的 GeoJSON Polygon，平面坐标单位为米。'); }
    if (room.seedM && !geometry.polygon.contains(geoJsonToJsts({
      type: 'Point', coordinates: [room.seedM[0], room.seedM[1]],
    })!))
      throw new Error('复核轮廓必须包含该房间的定位点。');
    const records = activeBoundaryRecords(file, scope);
    for (const peer of scope.rooms) {
      if (peer.id === roomId) continue;
      const outline = records.get(peer.id)?.reviewed?.outline ?? peer.outline;
      if (!outline) continue;
      const other = readPropertyPolygon(outline, 1).polygon;
      if (roomOutlinesOverlap(geometry.polygon, other))
        throw new Error(`复核轮廓与 ${peer.name}（${peer.id}）重叠，请核对边界。`);
    }
    reviewed = { outline: geometry.outline, areaM2: geometry.polygon.getArea() };
  }
  const previous = file.records.find(item => item.level === scope.level.id && item.roomId === roomId && item.snapshot === scope.snapshot);
  const propertyUse = reviewed && JSON.stringify(reviewed.outline) === JSON.stringify(previous?.reviewed?.outline)
    ? previous?.propertyUse : undefined;
  return { level: scope.level.id, roomId, modelRevision: scope.modelRevision, snapshot: scope.snapshot,
    group: room.group, decision, source: source.trim(), original, reviewed, propertyUse };
}

export function storeBoundaryRecord(file: BoundaryReviewFile, record: BoundaryRecord): BoundaryReviewFile {
  return { ...file, records: [...file.records.filter(item => item.level !== record.level ||
    item.roomId !== record.roomId || item.snapshot !== record.snapshot), record] };
}
