import { describe, expect, it } from 'vitest';
import { createHarness } from '../test/authorHarness.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { automaticRoomPatches, previewAutomaticRooms } from './autoRooms.ts';
import { previewPlanDoorAssignment } from './planDoorAssignment.ts';

function wall(id: string, start: Point, end: Point): LineElement {
  return { id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
    start, end, strokeWidth: 0.2, attrs: { id, thickness: '0.2' } };
}

function door(id: string, x: number, y = 2): LineElement {
  const hostId = `w-${x}`;
  return { id, tableName: 'door', discipline: 'architecture', geometry: 'line', hostId,
    start: { x, y: y - 0.45 }, end: { x, y: y + 0.45 }, strokeWidth: 0.08,
    attrs: { id, host_id: hostId, position: String(y) } };
}

const entry = { level: 'lv-1', elementId: 'd-entry' };
function plan(duplicate = false) {
  const h = createHarness([{ id: 'lv-1', number: '1', name: 'F1', elevation: 0 }]);
  const walls = [0, 4, 8, 12, 16].map(x => wall(`w-${x}`, { x, y: 0 }, { x, y: 4 }));
  walls.push(wall('w-bottom', { x: 0, y: 0 }, { x: 16, y: 0 }), wall('w-top', { x: 0, y: 4 }, { x: 16, y: 4 }));
  h.dispatch({ type: 'CREATE_ELEMENTS', elements: [
    ...walls, door('d-entry', 8), door('d-interior', 12), door('d-neighbour', 4),
    ...(duplicate ? [door('d-second-entry', 8, 3)] : []),
  ] });
  const rooms = previewAutomaticRooms(h.state, 'level');
  h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Create rooms',
    patches: automaticRoomPatches(h.state, rooms.rooms, rooms.firstNumber) });
  return h;
}

describe('door assignment with rooms created in the editor', () => {
  it('uses live room seeds and follows the door network on the chosen side', () => {
    const h = plan();
    const result = previewPlanDoorAssignment(h.state, entry, new Set());
    expect(result.source).toBe('floor-plan');
    expect(result.candidates.map(side => side.rooms.map(room => room.name))).toEqual([
      ['F1-room2', 'F1-room1'], ['F1-room3', 'F1-room4'],
    ]);
    expect(result.candidates[1].rooms.map(room => room.level)).toEqual(['lv-1', 'lv-1']);
    const hall = result.candidates[0].inside.elementId;
    expect(previewPlanDoorAssignment(h.state, entry, new Set([hall])).candidates).toEqual([result.candidates[1]]);
  });

  it('rejects a second door that reconnects the two sides', () => {
    expect(() => previewPlanDoorAssignment(plan(true).state, entry, new Set())).toThrow('两侧仍能通过其他门相通');
  });

  it('requires a valid position on the selected door host', () => {
    const h = plan();
    const bad = door('d-bad', 8, 9);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [bad] });
    expect(() => previewPlanDoorAssignment(h.state, { ...entry, elementId: bad.id }, new Set())).toThrow('宿主墙和门位置');
  });
});
