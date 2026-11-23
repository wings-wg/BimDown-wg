import { describe, expect, it } from 'vitest';
import type { LineElement, Point, PointElement } from '../model/elements.ts';
import { createHarness } from '../test/authorHarness.ts';
import { unitRoomView } from './unitRoomView.ts';

function wall(id: string, start: Point, end: Point): LineElement {
  return { id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
    start, end, strokeWidth: 0.2, attrs: { id, thickness: '0.2' } };
}

function room(id: string, x: number): PointElement {
  return { id, tableName: 'space', discipline: 'architecture', geometry: 'point',
    position: { x, y: 2 }, width: 0.3, height: 0.3, attrs: { id, x: String(x), y: '2' } };
}

describe('unit room selection in the plan', () => {
  it('selects all matching room seeds and frames their derived room outlines', () => {
    const h = createHarness();
    const corners = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }];
    const walls = corners.map((p, i) => wall(`w-${i + 1}`, p, corners[(i + 1) % corners.length]));
    walls.push(wall('w-5', { x: 5, y: 0 }, { x: 5, y: 5 }));
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [...walls, room('sp-1', 2), room('sp-2', 7)] });

    const view = unitRoomView(h.state, 'lv-1', new Set(['sp-1', 'sp-2', 'w-1', 'sp-99']))!;
    expect(view.ids).toEqual(['lv-1:sp-1', 'lv-1:sp-2']);
    expect(view.missing).toBe(2);
    expect(view.bounds).toEqual({ minX: -1.5, minY: -1.5, maxX: 11.5, maxY: 6.5 });
    h.dispatch({ type: 'SELECT', ids: view.ids, exact: true });
    expect(h.state.selectedIds).toEqual(new Set(view.ids));
  });

  it('waits for the target floor even when the room short ID is already in the old document', () => {
    const h = createHarness([
      { id: 'lv-1', name: 'F1', number: '1', elevation: 0 },
      { id: 'lv-2', name: 'F2', number: '2', elevation: 3 },
    ]);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [room('sp-1', 2)] });
    h.dispatch({ type: 'SET_LEVEL', levelId: 'lv-2' });
    expect(unitRoomView(h.state, 'lv-2', new Set(['sp-1']))).toBeNull();
    expect(unitRoomView(h.state, 'lv-1', new Set(['sp-1']))).toBeNull();
  });
});
