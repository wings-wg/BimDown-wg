import { describe, expect, it } from 'vitest';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { automaticRoomPatches, previewAutomaticRooms } from './autoRooms.ts';
import { previewFloorDoorAssignments } from './planDoorAssignment.ts';
import { currentFloorAssignmentColors, floorAssignmentColors } from './floorAssignmentColors.ts';
import { unitRoomView } from './unitRoomView.ts';

function fixture() {
  const h = createHarness([{ id: 'lv-1', number: '1', name: 'F1', elevation: 0 }]);
  const wall = (id: string, start: Point, end: Point): LineElement => ({ id, start, end,
    tableName: 'wall', discipline: 'architecture', geometry: 'line', strokeWidth: 0.2, attrs: { thickness: '0.2' } });
  const walls = [0, 4, 8, 12, 16].map(x => wall(`w-${x}`, { x, y: 0 }, { x, y: 4 }));
  walls.push(wall('bottom', { x: 0, y: 0 }, { x: 16, y: 0 }), wall('top', { x: 0, y: 4 }, { x: 16, y: 4 }));
  const doors = [4, 8, 12].map((x): LineElement => ({ id: `d-${x}`, tableName: 'door', discipline: 'architecture',
    geometry: 'line', start: { x, y: 1.5 }, end: { x, y: 2.5 }, hostId: `w-${x}`, strokeWidth: 0.08,
    attrs: { position: '2', is_unit_entrance: x < 12 ? 'true' : '' } }));
  h.dispatch({ type: 'CREATE_ELEMENTS', elements: [...walls, ...doors] });
  const rooms = previewAutomaticRooms(h.state, 'level');
  h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Synthetic rooms',
    patches: automaticRoomPatches(h.state, rooms.rooms, rooms.firstNumber) });
  return h;
}

describe('view-only floor assignment colors', () => {
  it('colors two households and a shared region from point rooms without writing any files', async () => {
    const h = fixture();
    const before = await saveHarness(h);
    const state = h.state;
    const plan = previewFloorDoorAssignments(state, 'lv-1', new Set());
    const units = new Map([['d-4', '101'], ['d-8', '102']]);
    const colors = floorAssignmentColors(state, plan, units);
    expect(plan.households).toHaveLength(2);
    expect(plan.commonAreas).toHaveLength(1);
    expect(colors.fills).toHaveLength(4);
    expect(new Set(colors.fills.map(room => room.color)).size).toBe(3);
    for (const group of plan.households) {
      const fills = colors.fills.filter(fill => group.candidate.rooms.some(room => room.elementId === fill.elementId));
      expect(new Set(fills.map(fill => fill.color))).toEqual(new Set([colors.households.get(group.doorId)]));
      expect(unitRoomView(state, plan.level, new Set(fills.map(fill => fill.elementId)))?.ids).toHaveLength(fills.length);
    }
    expect(currentFloorAssignmentColors(state, colors)).toBe(colors.fills);
    expect(currentFloorAssignmentColors(state)).toEqual([]);
    expect(currentFloorAssignmentColors({ ...state, currentLevel: 'lv-2' }, colors)).toEqual([]);
    expect(currentFloorAssignmentColors({ ...state, document: { ...state.document! } }, colors)).toEqual([]);
    expect(currentFloorAssignmentColors({ ...state, project: { ...state.project! } }, colors)).toEqual([]);
    expect(h.state).toBe(state);
    expect(await saveHarness(h)).toEqual(before);
  });

  it('preserves stored polygons and holes, scopes IDs and leaves unmatched rooms alone', () => {
    const h = fixture();
    const state = h.state;
    const plan = previewFloorDoorAssignments(state, 'lv-1', new Set());
    const room = plan.households[0].candidate.rooms[0];
    const elements = new Map(state.document!.elements);
    const vertices = [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }];
    elements.set(room.elementId, { ...elements.get(room.elementId)!, geometry: 'polygon', vertices, holes: [vertices.map(p => ({ x: p.x / 2, y: p.y / 2 }))] });
    const snapshot = { ...state, document: { ...state.document!, elements } };
    const colors = floorAssignmentColors(snapshot, { ...plan, households: [
      plan.households[0], { doorId: 'missing', candidate: { rooms: [{ level: 'lv-2', elementId: room.elementId }, { level: 'lv-1', elementId: 'unknown' }] } },
    ], commonAreas: [] }, new Map());
    expect(colors.fills).toHaveLength(1);
    expect(colors.fills[0].path.match(/Z/g)).toHaveLength(2);
    expect(colors.fills[0].path).toContain('M1,1');
  });

  it('uses one color when door groups share an edited unit number', () => {
    const h = fixture();
    const plan = previewFloorDoorAssignments(h.state, 'lv-1', new Set());
    const colors = floorAssignmentColors(h.state, plan, new Map([['d-4', '101'], ['d-8', '101']]));
    expect(colors.households.get('d-4')).toBe(colors.households.get('d-8'));
    expect(colors.commonAreas[0]).not.toBe(colors.households.get('d-4'));
  });
});
