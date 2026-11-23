import { boundaryWalls } from '../annotation/rooms.ts';
import { arcLength, pointOnArc } from '../geometry/arc.ts';
import { insidePoint } from '../geometry/pickBoundary.ts';
import { findSpaceBoundary, getSpaceFaceGraph, type SpaceFaceGraph } from '../geometry/spaceBoundary.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { spanningRoomWalls } from './autoRooms.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements } from './levelEdits.ts';

interface PlanRoom {
  level: string;
  elementId: string;
  uuid: string;
  name: string;
}

type Face = Point[] | null;

/** Sample both sides locally at the stored door position on the host centreline. */
function doorFaces(door: LineElement, host: LineElement, graph: SpaceFaceGraph, upm: number): [Face, Face] | null {
  const position = Number(door.attrs.position);
  const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y;
  const length = host.arc ? arcLength(host.start, host.end, host.arc) : Math.hypot(dx, dy);
  if (!door.attrs.position?.trim() || !Number.isFinite(position) || !Number.isFinite(length) ||
      position <= 0.02 * upm || length - position <= 0.02 * upm) return null;

  const sample = (offset: number, probe: number): [Face, Face] => {
    const t = (position + offset) / length;
    const { point, tangent } = host.arc ? pointOnArc(host.start, host.end, host.arc, t) : {
      point: { x: host.start.x + t * dx, y: host.start.y + t * dy },
      tangent: { x: dx / length, y: dy / length },
    };
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

/** Infer same-floor door connections from live walls and room seeds. */
export function previewPlanDoorAssignment(
  state: EditorState,
  entry: { level: string; elementId: string },
  excluded: ReadonlySet<string>,
) {
  const level = state.project?.levels.find(item => item.id === entry.level);
  if (!level || state.document?.levelId !== level.id) throw new Error('请先打开入户门所在的楼层。');
  const elements = [...levelElements(state, level.id).values()];
  const doors = elements.filter((el): el is LineElement => el.tableName === 'door' && el.geometry === 'line');
  if (!doors.some(door => door.id === entry.elementId)) throw new Error('所选对象不是当前楼层的门。');
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const walls = boundaryWalls(elements);
  const elevation = level.elevation + 0.01 * upm;
  const { spans } = spanningRoomWalls(state);
  for (const { wall, bottom, top } of spans) if (bottom <= elevation && top > elevation) walls.push(wall);
  const wallsById = new Map<string, LineElement | null>();
  for (const wall of walls) wallsById.set(wall.id, wallsById.has(wall.id) ? null : wall);
  const graph = getSpaceFaceGraph(walls);
  const byFace = new Map<Point[], PlanRoom[]>();
  for (const space of elements) {
    if (space.tableName !== 'space') continue;
    const seed = space.geometry === 'point' ? space.position :
      space.geometry === 'polygon' ? insidePoint(space.vertices) : null;
    const face = seed && findSpaceBoundary(graph, seed);
    if (!face) continue;
    const room = { level: level.id, elementId: space.id, name: space.attrs.name || space.id,
      uuid: JSON.stringify([level.id, 'space', space.id]) };
    const occupants = byFace.get(face) ?? [];
    occupants.push(room);
    byFace.set(face, occupants);
  }
  if (!byFace.size) throw new Error('本层没有可定位到闭合墙体区域的房间，请先创建房间并检查墙体边界。');

  const edges = new Map<string, [Face, Face]>();
  const neighbours = new Map<Point[], { door: string; target: Face }[]>();
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

  const sides = edges.get(entry.elementId);
  if (!sides) throw new Error('无法从所选门的宿主墙和门位置分辨两侧区域，请核对门定位与墙体闭合。');
  const occupantsOf = (face: Face) => face ? byFace.get(face) ?? [] : [];
  if (sides.some(face => occupantsOf(face).length > 1)) throw new Error('所选门的一侧有多个房间落在同一闭合区域，请先核对重复房间。');
  const candidates = sides.flatMap((start, index) => {
    const [inside] = occupantsOf(start);
    if (!start || !inside || excluded.has(inside.elementId)) return [];
    const opposite = sides[1 - index];
    const warnings = new Set<string>();
    if (!occupantsOf(opposite).length) warnings.add('门的另一侧未匹配到房间，请核对这一侧确实是户内。');
    const rooms: PlanRoom[] = [];
    const queue = [start];
    const visited = new Set(queue);
    for (const face of queue) {
      rooms.push(occupantsOf(face)[0]);
      for (const { door, target } of neighbours.get(face) ?? []) {
        if (door === entry.elementId || !target || visited.has(target)) continue;
        const occupants = occupantsOf(target);
        if (occupants.length !== 1) {
          warnings.add('部分相邻闭合区域缺少唯一房间，预览到这些区域为止。');
          continue;
        }
        if (excluded.has(occupants[0].elementId)) continue;
        if (target === opposite) throw new Error('切断所选门后两侧仍能通过其他门相通，请先核对公共房间和户界。');
        visited.add(target);
        queue.push(target);
      }
    }
    return [{ inside, rooms, warnings: [...warnings] }];
  });
  if (!candidates.length) throw new Error('门的两侧均没有可归户的房间，请核对房间是否已创建或已设为共有。');
  return { source: 'floor-plan' as const, entry, doorUuid: JSON.stringify([level.id, 'door', entry.elementId]), candidates };
}
