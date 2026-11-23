import { boundaryWalls, roomPolygon } from '../annotation/rooms.ts';
import { toSelectionId } from '../model/ids.ts';
import { elementBounds } from '../schedule/quantities.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import type { EditorState } from './editorTypes.ts';

/** Resolve scoped room IDs against the loaded document before selecting. */
export function unitRoomView(state: EditorState, levelId: string, roomIds: ReadonlySet<string>) {
  const doc = state.document;
  if (doc?.levelId !== levelId || state.currentLevel !== levelId) return null;

  const ids: string[] = [];
  const walls = boundaryWalls(doc.elements.values());
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of roomIds) {
    const room = doc.elements.get(id);
    if (room?.tableName !== 'space') continue;
    ids.push(toSelectionId(levelId, id));

    const polygon = roomPolygon(room, walls);
    const box = polygon?.length ? elementBounds({ ...room, geometry: 'polygon', vertices: polygon }) : elementBounds(room);
    if (![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)) continue;
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  const pad = 1.5 * unitsPerMetreOf(getProjectUnits(state));
  return { ids, missing: roomIds.size - ids.length, bounds: Number.isFinite(minX) ?
    { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad } : undefined };
}
