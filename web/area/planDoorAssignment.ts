import { boundaryWalls } from '../annotation/rooms.ts';
import { arcLength, pointOnArc } from '../geometry/arc.ts';
import { insidePoint } from '../geometry/pickBoundary.ts';
import { findSpaceBoundary, getSpaceFaceGraph, type SpaceFaceGraph } from '../geometry/spaceBoundary.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { spanningRoomWalls } from './autoRooms.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements } from './levelEdits.ts';
import { serializeToCsv } from '../model/serialize.ts';

interface PlanRoom {
  level: string;
  elementId: string;
  uuid: string;
  name: string;
}

type Face = Point[] | null;
type RoomFace = NonNullable<Face>;

function hasPublicCirculationUse(attrs: Record<string, string>) {
  if (attrs.circulation_use) return attrs.circulation_use === 'stairwell' || attrs.circulation_use === 'elevator_lobby';
  const name = attrs.name?.normalize('NFKC').trim() ?? '';
  return /^(?:[A-Z]?\d+[A-Z]?[#号-]?\s*)?(?:住宅|公共|疏散|消防|防烟|封闭)?(?:楼梯间|楼梯前室|楼梯间前室|电梯间|电梯厅|电梯前室|合用前室)(?:\s*[A-Z]?\d+[A-Z]?)?$/i.test(name) ||
    /^(?:stairwell|stair hall|elevator (?:lobby|hall)|lift (?:lobby|hall))(?:\s*[A-Z]?\d+[A-Z]?)?$/i.test(name);
}

function doorAxis(door: LineElement, host: LineElement, upm: number) {
  const position = Number(door.attrs.position);
  const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y;
  const length = host.arc ? arcLength(host.start, host.end, host.arc) : Math.hypot(dx, dy);
  if (!door.attrs.position?.trim() || !Number.isFinite(position) || !Number.isFinite(length) ||
      position <= 0.02 * upm || length - position <= 0.02 * upm) return null;

  return (offset: number) => {
    const t = (position + offset) / length;
    return host.arc ? pointOnArc(host.start, host.end, host.arc, t) : {
      point: { x: host.start.x + t * dx, y: host.start.y + t * dy },
      tangent: { x: dx / length, y: dy / length },
    };
  };
}

/** Sample both sides locally at the stored door position on the host centreline. */
function doorFaces(door: LineElement, host: LineElement, graph: SpaceFaceGraph, upm: number): [Face, Face] | null {
  const axis = doorAxis(door, host, upm);
  if (!axis) return null;
  const sample = (offset: number, probe: number): [Face, Face] => {
    const { point, tangent } = axis(offset);
    const a = findSpaceBoundary(graph, { x: point.x - tangent.y * probe, y: point.y + tangent.x * probe });
    const b = findSpaceBoundary(graph, { x: point.x + tangent.y * probe, y: point.y - tangent.x * probe });
    return [a, b];
  };
  const [left, right] = sample(0, 0.012 * upm);
  if (left === right) return null;
  for (const offset of [-0.02, 0.02]) {
    const [a, b] = sample(offset * upm, 0.02 * upm);
    if (a !== left || b !== right) return null;
  }
  return [left, right];
}

function floorDoorGeometry(state: EditorState, levelId: string) {
  const level = state.project?.levels.find(item => item.id === levelId);
  if (!level) throw new Error('未找到指定的楼层。');
  const elements = [...levelElements(state, level.id).values()];
  const doors = elements.filter((el): el is LineElement => el.tableName === 'door' && el.geometry === 'line');
  const entrances = new Set(elements.filter(door => door.tableName === 'door' && door.attrs.is_unit_entrance === 'true')
    .map(door => door.id));
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const walls = boundaryWalls(elements);
  const elevation = level.elevation + 0.01 * upm;
  const { spans } = spanningRoomWalls(state);
  for (const { wall, bottom, top } of spans) if (bottom <= elevation && top > elevation) walls.push(wall);
  const wallsById = new Map<string, LineElement | null>();
  for (const wall of walls) wallsById.set(wall.id, wallsById.has(wall.id) ? null : wall);
  return { elements, doors, entrances, walls, wallsById, upm };
}

function floorDoorGraph(state: EditorState, level: string, proposedEntrances?: ReadonlySet<string>) {
  if (state.document?.levelId !== level) throw new Error('请先打开要分户的楼层。');
  const { elements, doors, entrances, walls, wallsById, upm } = floorDoorGeometry(state, level);
  const graph = getSpaceFaceGraph(walls);
  const byFace = new Map<RoomFace, PlanRoom[]>();
  const circulationRooms = new Set<string>();
  for (const space of elements) {
    if (space.tableName !== 'space') continue;
    const seed = space.geometry === 'point' ? space.position :
      space.geometry === 'polygon' ? insidePoint(space.vertices) : null;
    const face = seed && findSpaceBoundary(graph, seed);
    if (!face) continue;
    const room = { level, elementId: space.id, name: space.attrs.name || space.id,
      uuid: JSON.stringify([level, 'space', space.id]) };
    if (hasPublicCirculationUse(space.attrs)) circulationRooms.add(space.id);
    const occupants = byFace.get(face) ?? [];
    occupants.push(room);
    byFace.set(face, occupants);
  }
  if (!byFace.size) throw new Error('本层没有可定位到闭合墙体区域的房间，请先创建房间并检查墙体边界。');

  const edges = new Map<string, [Face, Face]>();
  const neighbours = new Map<RoomFace, { door: string; target: Face }[]>();
  for (const door of doors) {
    const host = wallsById.get(door.hostId ?? '');
    const sides = host && doorFaces(door, host, graph, upm);
    if (!sides) continue;
    edges.set(door.id, sides);
    for (const [face, target] of [sides, [sides[1], sides[0]]]) {
      if (!face) continue;
      const links = neighbours.get(face) ?? [];
      links.push({ door: door.id, target });
      neighbours.set(face, links);
    }
  }

  return { doors, entrances: proposedEntrances ?? entrances, byFace, edges, neighbours, circulationRooms };
}

function traceDoorSide(
  graph: ReturnType<typeof floorDoorGraph>,
  start: RoomFace,
  barriers: ReadonlySet<string>,
  excluded?: ReadonlySet<string>,
) {
  const rooms: PlanRoom[] = [];
  const queue = [start];
  const faces = new Set(queue);
  const warnings = new Set<string>();
  for (const face of queue) {
    rooms.push(graph.byFace.get(face)![0]);
    for (const { door, target } of graph.neighbours.get(face) ?? []) {
      if (barriers.has(door) || !target || faces.has(target)) continue;
      const occupants = graph.byFace.get(target) ?? [];
      if (occupants.length !== 1) {
        warnings.add('部分相邻闭合区域缺少唯一房间，预览到这些区域为止。');
        continue;
      }
      if (excluded?.has(occupants[0].elementId)) continue;
      faces.add(target);
      queue.push(target);
    }
  }
  return { rooms, faces, warnings: [...warnings] };
}

/** Infer same-floor door connections from live walls and room seeds. */
export function previewPlanDoorAssignment(
  state: EditorState,
  entry: { level: string; elementId: string },
  excluded: ReadonlySet<string>,
) {
  const graph = floorDoorGraph(state, entry.level);
  const { doors, entrances, edges, byFace, circulationRooms } = graph;
  if (!doors.some(door => door.id === entry.elementId)) throw new Error('所选对象不是当前楼层的门。');
  const automatic = entrances.has(entry.elementId);
  const sides = edges.get(entry.elementId);
  if (!sides) throw new Error('无法从所选门的宿主墙和门位置分辨两侧区域，请核对门定位与墙体闭合。');
  const occupantsOf = (face: Face) => face ? byFace.get(face) ?? [] : [];
  if (sides.some(face => occupantsOf(face).length > 1)) throw new Error('所选门的一侧有多个房间落在同一闭合区域，请先核对重复房间。');
  if (automatic) {
    const unresolved = [...entrances].filter(id => !edges.has(id));
    if (unresolved.length) throw new Error(`本层有入户门无法识别两侧区域，请核对门 ${unresolved.join('、')} 的宿主墙和位置。`);
    if (sides.some(face => occupantsOf(face).length !== 1))
      throw new Error('入户门两侧需要各有一间可定位的房间。请补建房间或核对墙体边界。');
  }

  const barriers = automatic ? entrances : new Set([entry.elementId]);
  const candidates = sides.flatMap((start, index) => {
    const [inside] = occupantsOf(start);
    if (!start || !inside || (!automatic && excluded.has(inside.elementId))) return [];
    const opposite = sides[1 - index];
    const side = traceDoorSide(graph, start, barriers, automatic ? undefined : excluded);
    if (opposite && side.faces.has(opposite)) throw new Error('切断所选门后两侧仍能通过其他门相通，请先核对公共房间和户界。');
    const warnings = occupantsOf(opposite).length ? side.warnings :
      ['门的另一侧未匹配到房间，请核对这一侧确实是户内。', ...side.warnings];
    return [{ inside, rooms: side.rooms, warnings }];
  });
  if (!candidates.length) throw new Error('门的两侧均没有可归户的房间，请核对房间是否已创建或已设为共有。');
  const result = { source: 'floor-plan' as const, entry, doorUuid: JSON.stringify([entry.level, 'door', entry.elementId]), candidates };
  if (!automatic) return result;

  const publicSides = candidates.filter(side => side.rooms.some(room => circulationRooms.has(room.elementId)));
  if (!publicSides.length) throw new Error('入户门两侧均未找到可连通的楼梯间或电梯间。请在房间属性中标注「交通空间用途」。');
  if (publicSides.length !== 1) throw new Error('入户门两侧都能通向楼梯间或电梯间。请核对入户门标记和交通空间用途。');
  const [publicSide] = publicSides;
  const dwelling = candidates.find(side => side !== publicSide)!;
  if (dwelling.rooms.some(room => excluded.has(room.elementId)))
    throw new Error('拟归户的一侧与已设置的公共区域或排除房间相交，请核对入户门和原有归属。');
  return { ...result, candidates: [dwelling], publicSide: {
    rooms: publicSide.rooms,
    anchors: publicSide.rooms.filter(room => circulationRooms.has(room.elementId)),
    warnings: publicSide.warnings,
  } };
}

interface EntranceRegion {
  rooms: PlanRoom[];
  doorIds: Set<string>;
  incomplete: boolean;
}

/** Each region is visited once with all declared entrance doors treated as barriers. */
export function previewFloorDoorAssignments(
  state: EditorState, level: string, excluded: ReadonlySet<string>, proposedEntrances?: ReadonlySet<string>,
) {
  const graph = floorDoorGraph(state, level, proposedEntrances);
  if (graph.entrances.size < 2) throw new Error('本层至少需要标记两樘入户门，才能按共同连通区域批量分户。');
  const regionByFace = new Map<RoomFace, EntranceRegion>();
  function regionAt(face: RoomFace) {
    const previous = regionByFace.get(face);
    if (previous) return previous;
    const side = traceDoorSide(graph, face, graph.entrances);
    const region: EntranceRegion = { rooms: side.rooms, doorIds: new Set(), incomplete: side.warnings.length > 0 };
    for (const item of side.faces) regionByFace.set(item, region);
    return region;
  }

  const links = [...graph.entrances].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(doorId => {
    const sides = graph.edges.get(doorId);
    if (!sides) throw new Error(`入户门 ${doorId} 无法分辨两侧，请核对门的宿主墙和位置。`);
    const [left, right] = sides;
    if (!left || !right || graph.byFace.get(left)?.length !== 1 || graph.byFace.get(right)?.length !== 1)
      throw new Error(`入户门 ${doorId} 两侧需要各有一间可定位的房间，请核对房间和墙体边界。`);
    const leftRegion = regionAt(left);
    const rightRegion = regionAt(right);
    if (leftRegion === rightRegion) throw new Error(`入户门 ${doorId} 两侧仍可经普通门相通，请核对户界或补标入户门。`);
    if (leftRegion.incomplete || rightRegion.incomplete)
      throw new Error(`入户门 ${doorId} 连通范围内有缺失或重复的房间，请核对房间定位后重试。`);
    leftRegion.doorIds.add(doorId);
    rightRegion.doorIds.add(doorId);
    return { doorId, sides: [{ face: left, region: leftRegion }, { face: right, region: rightRegion }] };
  });

  const commonAreas: { rooms: PlanRoom[]; doorIds: string[] }[] = [];
  const areaIndex = new Map<EntranceRegion, number>();
  const households = links.map(({ doorId, sides }) => {
    const commonSides = sides.filter(({ region }) => region.doorIds.size > 1);
    if (commonSides.length !== 1) throw new Error(commonSides.length
      ? `入户门 ${doorId} 两侧都与其他入户门共用连通区域，请核对入户门标记和户界。`
      : `入户门 ${doorId} 两侧均无其他入户门共用的区域，请核对标记，或使用单门归户。`);
    const common = commonSides[0];
    const dwelling = sides.find(side => side !== common)!;
    if (dwelling.region.rooms.some(room => excluded.has(room.elementId)))
      throw new Error(`入户门 ${doorId} 的户内侧与已设共用或排除的房间相交，请核对原有归属。`);
    if (!areaIndex.has(common.region)) {
      areaIndex.set(common.region, commonAreas.length);
      commonAreas.push({ rooms: common.region.rooms, doorIds: [...common.region.doorIds] });
    }
    return { doorId, commonArea: areaIndex.get(common.region)!,
      candidate: { inside: graph.byFace.get(dwelling.face)![0], rooms: dwelling.region.rooms, warnings: [] } };
  });

  return { level, commonAreas, households };
}

/** Match projected entrance centres in the project's common XY coordinates. */
export function previewTransferredFloorDoors(
  state: EditorState, sourceLevel: string, targetLevel: string, sourceDoorIds: ReadonlySet<string>, excluded: ReadonlySet<string>,
) {
  if (sourceLevel === targetLevel) throw new Error('参照楼层和目标楼层必须不同。');
  if (sourceDoorIds.size < 2) throw new Error('参照层需要至少两樘有已归户记录的入户门。');
  const source = floorDoorGeometry(state, sourceLevel);
  const target = floorDoorGeometry(state, targetLevel);
  function centre(doorId: string, floor: ReturnType<typeof floorDoorGeometry>) {
    const door = floor.doors.find(item => item.id === doorId);
    const host = door && floor.wallsById.get(door.hostId ?? '');
    const point = door && host ? doorAxis(door, host, floor.upm)?.(0).point : undefined;
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
  }
  const targetPoints = target.doors.flatMap(door => {
    const point = centre(door.id, target);
    return point ? [{ doorId: door.id, point }] : [];
  });
  const proposed = new Set<string>();
  const matches = [...sourceDoorIds].map(sourceDoorId => {
    if (!source.entrances.has(sourceDoorId)) throw new Error(`参照层的 ${sourceDoorId} 当前没有入户门标记。`);
    const point = centre(sourceDoorId, source);
    if (!point) throw new Error(`参照层入户门 ${sourceDoorId} 缺少有效位置。`);
    const nearest = targetPoints.map(item => ({ targetDoorId: item.doorId,
      distanceMetres: Math.hypot(item.point.x - point.x, item.point.y - point.y) / target.upm }))
      .sort((a, b) => a.distanceMetres - b.distanceMetres);
    const [match, second] = nearest;
    if (!match || match.distanceMetres > 0.5) throw new Error(`参照门 ${sourceDoorId} 的投影在目标层 0.50 m 内没有候选门。`);
    if (second && second.distanceMetres - match.distanceMetres <= 0.05)
      throw new Error(`参照门 ${sourceDoorId} 附近有多个距离接近的候选门，请核对 ${match.targetDoorId}、${second.targetDoorId}。`);
    if (proposed.has(match.targetDoorId)) throw new Error(`多个参照门匹配到同一目标门 ${match.targetDoorId}，请核对门的位置。`);
    proposed.add(match.targetDoorId);
    return { sourceDoorId, ...match };
  });
  const extra = [...target.entrances].filter(id => !proposed.has(id));
  if (extra.length) throw new Error(`目标层还有未匹配的已标记入户门 ${extra.join('、')}，请核对后再迁移归户。`);
  return { ...previewFloorDoorAssignments(state, targetLevel, excluded, proposed), transfer: { sourceLevel, matches } };
}

export function stageTransferredDoorMarks(state: EditorState, level: string, doorIds: readonly string[]) {
  if (state.readonly || state.groupEdit || state.document?.levelId !== level) throw new Error('请在可编辑的目标楼层确认归户。');
  const patches = new Map<string, LineElement>();
  for (const id of doorIds) {
    const door = state.document.elements.get(id);
    if (door?.tableName !== 'door' || door.geometry !== 'line') throw new Error(`目标门 ${id} 已变化，请重新预览。`);
    if (door.attrs.is_unit_entrance !== 'true')
      patches.set(id, { ...door, attrs: { ...door.attrs, is_unit_entrance: 'true' } });
  }
  const doors = [...state.document.elements.values()].filter(element => element.tableName === 'door');
  const csv = serializeToCsv(doors.map(door => patches.get(door.id) ?? door), 'door', state.project?.types);
  return { csv, patches: new Map([[level, patches]]) };
}
