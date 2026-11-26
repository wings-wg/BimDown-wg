import type { ProjectAreaConfig } from './project-input.js';

interface RoomConnection {
  doorUuid: string;
  targetRoomUuid: string | null;
  relation: string;
  isUnitEntrance?: boolean | null;
}

interface RoomEvidence {
  uuid: string;
  id: string | null;
  name?: string;
  phaseUuid: string;
  isCommon?: boolean | null;
  connections: RoomConnection[];
}

interface ScopedObject { level: string; elementId: string }
interface Mapping { id: string; uuid: string; directory: string }
interface CandidateRoom extends ScopedObject { uuid: string; name: string }
export interface DoorCandidate {
  inside: CandidateRoom;
  rooms: CandidateRoom[];
  warnings: string[];
}
export interface DoorAssignmentPreview {
  source?: 'floor-plan';
  doorUuid: string;
  entry: ScopedObject;
  candidates: DoorCandidate[];
  transferSource?: string;
  publicSide?: { rooms: CandidateRoom[]; anchors: CandidateRoom[]; warnings: string[]; sharedDoorIds?: string[] };
}

export interface FloorDoorAssignmentPreview {
  level: string;
  commonAreas: { rooms: CandidateRoom[]; doorIds: string[] }[];
  households: { doorId: string; commonArea: number; candidate: DoorCandidate }[];
  transfer?: { sourceLevel: string; matches: { sourceDoorId: string; targetDoorId: string; distanceMetres: number }[] };
}

const scopedKey = ({ level, elementId }: ScopedObject) => JSON.stringify([level, elementId]);

/** Read scoped entrance references from existing single-door and batch assignment evidence. */
export function assignedEntranceIds(config: ProjectAreaConfig, level: string) {
  const units = new Set(config.nodes.filter(node => node.type === 'unit').map(node => node.id));
  const prefix = `入户门 ${level}/door/`;
  return new Set(config.selections.flatMap(item => {
    if (item.level !== level || item.table !== 'space' || item.kind === 'common' || item.kind === 'excluded' ||
        !units.has(item.owner) || typeof item.source !== 'string') return [];
    const evidence = item.source.split('；');
    if (evidence.includes('网页手动归户')) return [];
    const doorId = evidence.find(part => part.startsWith(prefix))?.slice(prefix.length).split('（')[0];
    return doorId ? [doorId] : [];
  }));
}

/** Preview connected components on either side of an explicitly selected entrance. */
export function previewDoorAssignment(
  evidence: { version: number; rooms: RoomEvidence[] },
  mappings: Mapping[],
  entry: ScopedObject,
  config: ProjectAreaConfig,
) {
  if (evidence?.version !== 1 || !Array.isArray(evidence.rooms))
    throw new Error('缺少可用的 Revit 门—房间连通证据。');
  if (!evidence.rooms.length)
    throw new Error('无法预览：导出包中没有房间记录。请在 Revit 核对房间已放置、有面积，并勾选房间和门后重新导出。');
  const door = mappings.filter(row => row.directory === entry.level && row.id === entry.elementId);
  if (door.length !== 1 || !door[0].uuid)
    throw new Error('无法唯一定位所选门。请检查导出包的楼层与 _IdMap.csv，必要时用新版插件重新导出。');
  const doorUuid = door[0].uuid;
  const byUuid = new Map<string, RoomEvidence>();
  for (const room of evidence.rooms) {
    if (!room?.uuid || !Array.isArray(room.connections) || byUuid.has(room.uuid))
      throw new Error('房间连通证据不完整或房间 UUID 重复。');
    byUuid.set(room.uuid, room);
  }
  const mappingByUuid = new Map<string, Mapping[]>();
  const mappingByScope = new Map<string, number>();
  for (const row of mappings) {
    const key = scopedKey({ level: row.directory, elementId: row.id });
    mappingByScope.set(key, (mappingByScope.get(key) ?? 0) + 1);
    const rows = mappingByUuid.get(row.uuid) ?? [];
    rows.push(row);
    mappingByUuid.set(row.uuid, rows);
  }
  function roomObject(room: RoomEvidence): CandidateRoom {
    const mapped = mappingByUuid.get(room.uuid);
    if (!mapped || mapped.length !== 1 || !room.id || mapped[0].id !== room.id)
      throw new Error(`房间 ${room.name || room.uuid} 缺少唯一的模型对象映射。`);
    const object = { uuid: room.uuid, name: room.name || room.id, level: mapped[0].directory, elementId: room.id };
    if (!object.level || mappingByScope.get(scopedKey(object)) !== 1)
      throw new Error(`房间 ${object.name} 的楼层与短 ID 映射不唯一，请重新导出。`);
    return object;
  }
  const entries = evidence.rooms.flatMap(room => room.connections
    .filter(connection => connection?.doorUuid === doorUuid).map(connection => ({ room, connection })));
  if (!entries.length) throw new Error('所选门没有与已导出房间关联。请检查房间放置、阶段与导出范围。');
  if (entries.length > 2 || !entries[0].room.phaseUuid ||
      entries.some(({ room }) => room.phaseUuid !== entries[0].room.phaseUuid))
    throw new Error('所选门的房间关系跨多个阶段或存在冲突，无法确定户内侧。');
  const [{ room: first, connection: firstEdge }, other] = entries;
  if (other && (other.room === first || firstEdge.relation !== 'door_adjacency' ||
      other.connection.relation !== 'door_adjacency' || firstEdge.targetRoomUuid !== other.room.uuid ||
      other.connection.targetRoomUuid !== first.uuid))
    throw new Error('入户门两侧的房间关系不一致。');
  if (!other && (firstEdge.targetRoomUuid !== null || firstEdge.relation !== 'unresolved_or_exterior'))
    throw new Error('入户门另一侧指向未导出的房间，请补齐房间连通证据。');

  const excludedOwners = new Set(config.nodes.filter(node => node.type === 'pool' || node.type === 'excluded').map(node => node.id));
  const excluded = new Set(config.selections.filter(item => item.table === 'space' && excludedOwners.has(item.owner)).map(scopedKey));
  const entryUuids = new Set(entries.map(({ room }) => room.uuid));
  const candidates: DoorCandidate[] = [];
  let reconnected = false;
  for (const { room: start } of entries) {
    if (start.isCommon === true) continue;
    const inside = roomObject(start);
    if (inside.level !== entry.level || excluded.has(scopedKey(inside))) continue;
    const warnings = new Set<string>();
    if (!other) warnings.add('入户门另一侧未解析，请核对已识别侧确实为户内。');
    const rooms: CandidateRoom[] = [];
    const queue = [start];
    const visited = new Set([start.uuid]);
    for (const room of queue) {
      const object = roomObject(room);
      rooms.push(object);
      for (const edge of room.connections) {
        if (edge?.doorUuid === doorUuid || edge?.isUnitEntrance === true) continue;
        const next = edge?.targetRoomUuid ? byUuid.get(edge.targetRoomUuid) : undefined;
        if (!next || next.phaseUuid !== start.phaseUuid || edge.relation !== 'door_adjacency' ||
            !next.connections.some(back => back?.doorUuid === edge.doorUuid && !!edge.doorUuid &&
              back.targetRoomUuid === room.uuid && back.relation === 'door_adjacency')) {
          warnings.add('部分门的相邻房间、阶段或双向关系未确认，请核对预览是否完整。');
          continue;
        }
        if (visited.has(next.uuid) || next.isCommon === true || next.connections.some(back =>
          back?.doorUuid === edge.doorUuid && back.isUnitEntrance === true)) continue;
        const target = roomObject(next);
        if (target.level !== entry.level) {
          warnings.add('候选范围仅含当前楼层，请另行核对跨层房间。');
          continue;
        }
        if (excluded.has(scopedKey(target))) continue;
        visited.add(next.uuid);
        queue.push(next);
      }
    }
    if (rooms.some(room => room.uuid !== start.uuid && entryUuids.has(room.uuid))) {
      reconnected = true;
      continue;
    }
    candidates.push({ inside, rooms, warnings: [...warnings] });
  }
  if (reconnected) throw new Error('切断所选门后两侧仍可通过其他门相通，请先明确公共房间或其他户界门。');
  if (!candidates.length) throw new Error('该门没有当前楼层可归户的候选房间。');
  return { doorUuid, entry, candidates };
}

export function resolveAssignmentUnit(config: ProjectAreaConfig, unit: string): ProjectAreaConfig['nodes'][number] {
  if (!unit.trim()) throw new Error('请填写户号。');
  const owner = config.nodes.find(node => node.id === unit);
  if (owner && owner.type !== 'unit') throw new Error('该户号已用于共有池或排除节点。');
  const buildings = new Set(config.nodes.map(node => node.building));
  if (!owner && buildings.size > 1) throw new Error('配置有多栋建筑，请先在配置 JSON 中为该户号指定所属建筑。');
  return owner ?? { id: unit, type: 'unit', building: [...buildings][0] ?? 'B1' };
}

export function applyDoorAssignment(
  config: ProjectAreaConfig,
  preview: DoorAssignmentPreview,
  candidate: DoorCandidate,
  unit: string,
): ProjectAreaConfig {
  const owner = resolveAssignmentUnit(config, unit);
  const selections = [...config.selections];
  const commonRooms = new Map(config.commonRoomDrafts?.map(room => [scopedKey(room), room]));
  const entrance = `${preview.entry.level}/door/${preview.entry.elementId}`;
  if (preview.publicSide) {
    const anchors = preview.publicSide.anchors.map(room => `${room.level}/space/${room.elementId}`).join('、');
    const sharedDoors = preview.publicSide.sharedDoorIds?.map(id => `${preview.entry.level}/door/${id}`).join('、');
    const source = sharedDoors ? `网页平面几何推断；共同连通的入户门 ${sharedDoors}` :
      `网页平面几何推断；入户门 ${entrance}；公共交通空间 ${anchors}`;
    const types = new Map(config.nodes.map(node => [node.id, node.type]));
    const commonIds = new Set(preview.publicSide.rooms.map(scopedKey));
    if (candidate.rooms.some(room => commonIds.has(scopedKey(room))))
      throw new Error('公共侧与拟归户的房间发生重叠，请重新预览。');
    for (const room of preview.publicSide.rooms) {
      const previous = selections.find(item => item.table === 'space' && scopedKey(item) === scopedKey(room));
      if (previous && (previous.kind !== 'common' || types.get(previous.owner) !== 'pool'))
        throw new Error(`公共侧的房间 ${room.name} 已有其他归属，请先核对原配置。`);
      const key = scopedKey(room);
      if (sharedDoors || !commonRooms.has(key)) commonRooms.set(key, { level: room.level, elementId: room.elementId, source });
    }
  }
  for (const room of candidate.rooms) {
    if (commonRooms.has(scopedKey(room))) throw new Error(`房间 ${room.name} 已标为共用，请先核对原归属。`);
    const assigned = selections.find(item => item.table === 'space' && scopedKey(item) === scopedKey(room));
    if (assigned) {
      if (assigned.owner !== unit || assigned.kind === 'common' || assigned.kind === 'excluded')
        throw new Error(`房间 ${room.name} 已有其他归属，请先核对原配置。`);
      continue;
    }
    const id = `${room.level}/space/${room.elementId}`;
    if (selections.some(item => item.id === id) || config.parts?.some(part => part.id === id))
      throw new Error(`分项 ID ${id} 已存在，请核对原配置。`);
    const evidence = preview.source === 'floor-plan'
      ? `网页平面几何推断；入户门 ${entrance}；户内起点 ${candidate.inside.level}/space/${candidate.inside.elementId}；房间 ${id}`
      : `area_features.json；入户门 ${entrance}（${preview.doorUuid}）；户内起点 ${candidate.inside.uuid}；房间 ${room.uuid}`;
    selections.push({ id, level: room.level, table: 'space', elementId: room.elementId, owner: unit,
      kind: 'usable', factor: 1,
      source: [evidence, preview.transferSource, '已确认归户，测算边界与系数待审核'].filter(Boolean).join('；') });
  }
  return { ...config, confirmed: false, selections,
    ...(preview.publicSide && { commonRoomDrafts: [...commonRooms.values()] }),
    nodes: config.nodes.includes(owner) ? config.nodes : [...config.nodes, owner] };
}

/** Stage the complete floor assignment in memory. The caller persists only a successful result. */
export function applyFloorDoorAssignments(
  config: ProjectAreaConfig,
  preview: FloorDoorAssignmentPreview,
  unitNumbers: ReadonlyMap<string, string>,
): ProjectAreaConfig {
  if (preview.households.length < 2) throw new Error('本层批量分户至少需要两樘入户门。');
  const assigned = preview.households.map(household => ({ ...household, unit: unitNumbers.get(household.doorId)?.trim() ?? '' }));
  if (assigned.some(item => !item.unit)) throw new Error('请为每樘入户门填写户号。');
  if (new Set(assigned.map(item => item.unit)).size !== assigned.length) throw new Error('本层批量分户的户号不能重复。');

  let result = config;
  const stagedCommonAreas = new Set<number>();
  for (const { doorId, candidate, commonArea, unit } of assigned) {
    const entry = { level: preview.level, elementId: doorId };
    const area = preview.commonAreas[commonArea];
    if (!area?.doorIds.includes(doorId)) throw new Error(`入户门 ${doorId} 缺少对应的公共侧，请重新预览。`);
    const roomIds = new Set(candidate.rooms.map(room => room.elementId));
    if (config.selections.some(item => item.level === preview.level && item.table === 'space' &&
        item.owner === unit && item.kind !== 'common' && item.kind !== 'excluded' && !roomIds.has(item.elementId)))
      throw new Error(`户号 ${unit} 在本层已有房间位于 ${doorId} 的户内范围之外，请核对户号或户界。`);
    const publicSide = stagedCommonAreas.has(commonArea) ? undefined :
      { rooms: area.rooms, anchors: [], warnings: [], sharedDoorIds: area.doorIds };
    const reference = preview.transfer?.matches.find(match => match.targetDoorId === doorId);
    const transferSource = preview.transfer && reference ?
      `位置参照 ${preview.transfer.sourceLevel}/door/${reference.sourceDoorId}；平面偏差 ${reference.distanceMetres.toFixed(3)} m` : undefined;
    result = applyDoorAssignment(result, {
      source: 'floor-plan', entry, doorUuid: JSON.stringify([entry.level, 'door', doorId]), candidates: [candidate], publicSide, transferSource,
    }, candidate, unit);
    stagedCommonAreas.add(commonArea);
  }
  return result;
}
