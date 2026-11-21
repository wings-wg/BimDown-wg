import { boundaryWalls } from '../annotation/rooms.ts';
import { insidePoint } from '../geometry/pickBoundary.ts';
import { roomAreas } from '../geometry/roomArea.ts';
import { BOUNDARY_TABLES, findSpaceBoundary, getSpaceFaceGraph, pointInPolygon } from '../geometry/spaceBoundary.ts';
import type { LineElement, Point, PointElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { parseLayer } from '../model/parse.ts';
import { cleanNumber } from '../model/serialize.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements, takenIds, type LevelPatches } from './levelEdits.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';

export interface AutomaticRoom {
  levelId: string;
  levelName: string;
  point: Point;
  areaM2: number;
  centrelineArea: boolean;
}

type Scope = 'level' | 'project';
const boundaryTables = new Set<string>(BOUNDARY_TABLES);

export function automaticRoomName(levelName: string, sequence: number) {
  return `${levelName}-room${sequence}`;
}

/** Search the wall graph used for native room placement and area labels. */
export function previewAutomaticRooms(state: EditorState, scope: Scope) {
  if (!state.project || state.readonly || state.groupEdit || !state.document ||
      state.currentLevel !== state.document.levelId) throw new Error('请先打开可编辑的楼层并退出组编辑。');

  const levels = [...state.project.levels].sort((a, b) => a.elevation - b.elevation);
  const elevations = new Map(levels.map(level => [level.id, level.elevation]));
  const elementsByLevel = new Map(levels.map(level => [level.id, levelElements(state, level.id)]));
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const globalWalls = boundaryWalls(state.project.globalLayers.filter(layer =>
    boundaryTables.has(layer.tableName)).flatMap(parseLayer));
  const globalSpans = globalWalls.flatMap((wall): { wall: LineElement; bottom: number; top: number }[] => {
    const base = elevations.get(wall.attrs.base_level_id || wall.attrs.level_id);
    if (base === undefined) return [];
    const bottom = base + (Number(wall.attrs.base_offset) || 0);
    const topLevel = elevations.get(wall.attrs.top_level_id);
    const height = Number(wall.attrs.height);
    const top = topLevel === undefined
      ? height > 0 ? bottom + height : undefined
      : topLevel + (Number(wall.attrs.top_offset) || 0);
    return top !== undefined && Number.isFinite(top) && Number.isFinite(bottom) && top > bottom
      ? [{ wall, bottom, top }] : [];
  });

  let firstNumber = 1;
  for (const elements of elementsByLevel.values()) {
    for (const element of elements.values()) {
      if (element.tableName !== 'space') continue;
      const sequences = [element.attrs.number?.match(/^room(\d+)$/i), element.attrs.name?.match(/-room(\d+)$/i)];
      for (const match of sequences) {
        const previous = Number(match?.[1]);
        if (Number.isSafeInteger(previous)) firstNumber = Math.max(firstNumber, previous + 1);
      }
    }
  }

  const rooms: AutomaticRoom[] = [];
  let existing = 0;
  let unresolved = 0;
  let skipped = 0;
  for (const level of levels) {
    if (scope === 'level' && level.id !== state.currentLevel) continue;
    const elements = elementsByLevel.get(level.id)!;
    const walls = boundaryWalls(elements.values());
    const elevation = level.elevation + 0.01 * upm;
    for (const { wall, bottom, top } of globalSpans) {
      if (bottom <= elevation && top > elevation) walls.push(wall);
    }
    const graph = getSpaceFaceGraph(walls);
    const occupied = new Set<Point[]>();
    for (const element of elements.values()) {
      if (element.tableName !== 'space') continue;
      const point = element.geometry === 'point' ? element.position
        : element.geometry === 'polygon' ? insidePoint(element.vertices) : null;
      const outline = point && findSpaceBoundary(graph, point);
      if (outline) occupied.add(outline);
      else unresolved++;
    }
    existing += occupied.size;

    const faces = graph.faces.map(face => ({ face, seed: insidePoint(face.polygon) }));
    // Disconnected wall rings can produce nested, overlapping faces without holes.
    const nested = new Set<Point[]>();
    for (const { face, seed } of faces) {
      if (!seed) continue;
      for (const { face: outer } of faces) {
        if (outer.signedArea <= face.signedArea || outer.minX > face.minX || outer.minY > face.minY ||
            outer.maxX < face.maxX || outer.maxY < face.maxY || !pointInPolygon(seed.x, seed.y, outer.polygon)) continue;
        nested.add(face.polygon);
        nested.add(outer.polygon);
      }
    }
    const candidates: AutomaticRoom[] = [];
    for (const { face, seed } of faces) {
      if (occupied.has(face.polygon)) continue;
      if (nested.has(face.polygon) || !seed) {
        skipped++;
        continue;
      }
      const { area, netPolygon } = roomAreas(face.polygon, walls, upm);
      // Use the same precision the native CSV save uses, then confirm the seed still resolves.
      const preferred = (netPolygon && insidePoint(netPolygon)) ?? seed;
      const point = preferred && { x: Number(cleanNumber(String(preferred.x))), y: Number(cleanNumber(String(preferred.y))) };
      if (!point || !Number.isFinite(area) || area <= 0 ||
          findSpaceBoundary(graph, point) !== face.polygon) {
        skipped++;
        continue;
      }
      candidates.push({ levelId: level.id, levelName: level.name.trim() || level.id, point,
        areaM2: area / (upm * upm), centrelineArea: !netPolygon });
    }
    rooms.push(...candidates.sort((a, b) => b.point.y - a.point.y || a.point.x - b.point.x));
  }
  return { rooms, firstNumber, existing, unresolved, skipped, unscopedWalls: globalWalls.length - globalSpans.length };
}

/** Add native space seeds in one undoable model edit. */
export function automaticRoomPatches(state: EditorState, rooms: AutomaticRoom[], firstNumber: number): LevelPatches {
  if (!Number.isSafeInteger(firstNumber + rooms.length - 1)) throw new Error('房间编号超出可用范围。');
  const patches: LevelPatches = new Map();
  const reserved = new Map<string, Set<string>>();
  for (const [offset, room] of rooms.entries()) {
    const sequence = firstNumber + offset;
    let ids = reserved.get(room.levelId);
    if (!ids) {
      ids = takenIds(state, room.levelId);
      reserved.set(room.levelId, ids);
    }
    const id = generateId('space', ids);
    ids.add(id);
    const roomElement: PointElement = {
      id, tableName: 'space', discipline: 'architecture', geometry: 'point', position: room.point,
      width: 0.3, height: 0.3,
      attrs: {
        id, name: automaticRoomName(room.levelName, sequence), number: `room${sequence}`,
        x: String(room.point.x), y: String(room.point.y),
      },
    };
    const patch = patches.get(room.levelId) ?? new Map();
    patch.set(id, roomElement);
    patches.set(room.levelId, patch);
  }
  return patches;
}
