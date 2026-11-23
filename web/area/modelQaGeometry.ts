import { insidePoint } from '../geometry/pickBoundary.ts';
import { matchRoomEdges } from '../geometry/roomArea.ts';
import { findSpaceBoundary, getSpaceFaceGraph } from '../geometry/spaceBoundary.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { roomBoundaryWalls, spanningRoomWalls } from './autoRooms.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements } from './levelEdits.ts';

/** Derive plan boundary evidence and report only explicitly locatable wall heights. */
export function describeRoomBoundaries(state: EditorState, levelId: string, roomIds: string[]) {
  const project = state.project;
  const level = project?.levels.find(item => item.id === levelId);
  if (!project || !level) return new Map();
  const elements = levelElements(state, levelId);
  const elevations = new Map(project.levels.map(item => [item.id, item.elevation]));
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const walls = roomBoundaryWalls(elements.values(), level, upm, spanningRoomWalls(state).spans);
  const graph = getSpaceFaceGraph(walls);
  return new Map(roomIds.map(id => {
    const room = elements.get(id);
    const seed = room?.geometry === 'point' ? room.position :
      room?.geometry === 'polygon' ? insidePoint(room.vertices) : null;
    const face = seed && findSpaceBoundary(graph, seed);
    const edges = face ? matchRoomEdges(face, walls, upm) : [];
    const boundaryWalls = new Map(edges.flatMap(({ wall }) => {
      if (!wall) return [];
      const base = elevations.get(wall.attrs.base_level_id || wall.attrs.level_id);
      const top = elevations.get(wall.attrs.top_level_id);
      const offset = (value: string | undefined) => Number(value || 0);
      const span = base !== undefined && top !== undefined
        ? top + offset(wall.attrs.top_offset) - base - offset(wall.attrs.base_offset)
        : NaN;
      const heightM = Number.isFinite(span) && span >= 0 ? Number((span / upm).toFixed(4)) : null;
      return [[wall.id, { id: wall.id, table: wall.tableName, heightM }] as const];
    }));
    return [id, {
      closedPlan: !!face, unmatchedWallEdges: edges.filter(edge => !edge.wall).length,
      boundaryWalls: [...boundaryWalls.values()].slice(0, 12),
    }] as const;
  }));
}
