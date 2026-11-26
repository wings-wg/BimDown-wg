import { roomPolygon } from '../annotation/rooms.ts';
import type { Point } from '../model/elements.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { roomBoundaryWalls, spanningRoomWalls } from './autoRooms.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements } from './levelEdits.ts';

type Room = { level: string; elementId: string };
type Plan = { level: string; households: { doorId: string; candidate: { rooms: Room[] } }[];
  commonAreas: { rooms: Room[] }[] };
export type PreviewRoomFill = { level: string; elementId: string; color: string; path: string };
export type FloorAssignmentColors = {
  level: string; snapshot: EditorState; fills: PreviewRoomFill[];
  households: Map<string, string>; commonAreas: string[];
};

/** View-only geometry. Never writes room outlines or assignment configuration. */
export function floorAssignmentColors(state: EditorState, plan: Plan, units: ReadonlyMap<string, string>): FloorAssignmentColors {
  const result: FloorAssignmentColors = { level: plan.level, snapshot: state, fills: [], households: new Map(), commonAreas: [] };
  const level = state.project?.levels.find(item => item.id === plan.level);
  if (!level || state.currentLevel !== plan.level || state.document?.levelId !== plan.level) return result;
  const elements = levelElements(state, plan.level);
  const walls = roomBoundaryWalls([...elements.values()], level, unitsPerMetreOf(getProjectUnits(state)), spanningRoomWalls(state).spans);
  const colors = new Map<string, string>();
  const colorFor = (key: string) => {
    if (!colors.has(key)) colors.set(key, `hsl(${(colors.size * 137.508 + 24) % 360} 72% 48%)`);
    return colors.get(key)!;
  };
  const add = (rooms: Room[], color: string) => {
    for (const ref of rooms) {
      if (ref.level !== plan.level) continue;
      const room = elements.get(ref.elementId);
      if (room?.tableName !== 'space') continue;
      const polygon = roomPolygon(room, walls);
      const rings = polygon && [polygon, ...(room.geometry === 'polygon' ? room.holes ?? [] : [])];
      if (!rings || rings.some(ring => ring.length < 3 || ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) continue;
      const ringPath = (ring: Point[]) => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z';
      result.fills.push({ ...ref, color, path: rings.map(ringPath).join(' ') });
    }
  };
  for (const { doorId, candidate } of plan.households) {
    const color = colorFor(`unit:${units.get(doorId)?.trim() || doorId}`);
    result.households.set(doorId, color);
    add(candidate.rooms, color);
  }
  plan.commonAreas.forEach((area, index) => {
    const color = colorFor(`common:${index}`);
    result.commonAreas.push(color);
    add(area.rooms, color);
  });
  return result;
}

/** Reject stale snapshots immediately, even before the host's invalidation effect. */
export function currentFloorAssignmentColors(state: EditorState, preview?: FloorAssignmentColors) {
  const before = preview?.snapshot;
  return before && state.currentLevel === preview.level && state.document === before.document &&
    state.project === before.project ? preview.fills : [];
}
