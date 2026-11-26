import { describe, expect, it } from 'vitest';
import type { ProjectAreaConfig } from './core/project-input.js';
import { listCommonRooms, saveRoomAllocation } from './common-room-allocation.js';
import { assignSelectedRooms } from './manual-room-assignment.js';

const empty: ProjectAreaConfig = {
  version: 1, confirmed: true, ruleSource: 'Synthetic', nodes: [], groups: [], selections: [],
};
const space = (number: number, level = 'lv-1') => ({ level, elementId: `sp-${number}`, name: `F1-room${number}` });

describe('manual room assignment', () => {
  it('adds selected rooms to the requested households without requiring polygons', () => {
    const rooms102 = [space(1), space(3), space(14)];
    const first = assignSelectedRooms(empty, [...rooms102, rooms102[0]], ' 102 ', false);
    const rooms101 = [space(2), space(5)];
    const both = assignSelectedRooms(first, rooms101, '101', false);
    expect(both.confirmed).toBe(false);
    expect(both.nodes.map(node => node.id)).toEqual(['102', '101']);
    expect(both.selections.map(item => [item.elementId, item.owner])).toEqual([
      ['sp-1', '102'], ['sp-3', '102'], ['sp-14', '102'], ['sp-2', '101'], ['sp-5', '101'],
    ]);
    expect(listCommonRooms(both, [...rooms102, ...rooms101, space(6)]).map(item => item.room.elementId))
      .toEqual(['sp-6']);
    expect(empty.selections).toEqual([]);
  });

  it('confirms moves and keeps scoped IDs, coefficients and existing boundary evidence', () => {
    const room = space(1);
    const first = assignSelectedRooms(empty, [room, space(1, 'lv-2')], '101', false);
    first.selections[0].factor = 0.5;
    const previousSource = first.selections[0].source;
    expect(() => assignSelectedRooms(first, [space(3), room], '102', false)).toThrow('确认改归');
    expect(first.selections).toHaveLength(2);
    const result = assignSelectedRooms(first, [room], '102', true);
    expect(result.selections[0]).toMatchObject({ level: 'lv-1', owner: '102', factor: 0.5 });
    expect(result.selections[0].source).toContain(previousSource);
    expect(result.selections[1]).toMatchObject({ level: 'lv-2', owner: '101' });
  });

  it('removes the moved room’s own shared rule and preserves other pools', () => {
    const first = assignSelectedRooms(empty, [space(1)], '101', false);
    const rule = { recipients: ['101'], method: 'equal' as const, factor: 1 as const,
      boundarySource: 'Synthetic boundary', allocationSource: 'Synthetic rule' };
    const configured = saveRoomAllocation(saveRoomAllocation(first, space(2), rule), space(3), rule);
    const result = assignSelectedRooms(configured, [space(2)], '102', true);
    expect(result.groups).toEqual([configured.groups[1]]);
    expect(result.nodes).not.toContainEqual(configured.nodes[1]);
    expect(result.selections[1]).toMatchObject({ owner: '102', elementId: 'sp-2', kind: 'usable' });
  });

  it('keeps the planned public side visible until a scoped room is explicitly reassigned', () => {
    const room = space(1);
    const draft = { ...empty, commonRoomDrafts: [{ ...room, source: 'entrance plan' }] };
    expect(listCommonRooms(draft, [room, space(1, 'lv-2')]).map(item => item.room)).toEqual([room]);
    const withUnit = assignSelectedRooms(draft, [space(3), space(3, 'lv-2')], '101', false);
    expect(listCommonRooms(withUnit, [room, space(2), space(2, 'lv-2')]).map(item => item.room))
      .toEqual([room, space(2, 'lv-2')]);
    expect(() => assignSelectedRooms(draft, [room], '101', false)).toThrow('确认改归');
    expect(assignSelectedRooms(draft, [room], '101', true).commonRoomDrafts).toEqual([]);
  });
});
