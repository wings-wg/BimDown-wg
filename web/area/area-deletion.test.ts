import { describe, expect, it } from 'vitest';
import type { ProjectAreaConfig } from './core/project-input.js';
import { removeAreaRooms, removeAreaUnit } from './area-deletion.js';
import { listCommonRooms, roomPoolId, saveRoomAllocation } from './common-room-allocation.js';
import { assignSelectedRooms } from './manual-room-assignment.js';

const empty: ProjectAreaConfig = {
  version: 1, confirmed: false, ruleSource: 'Synthetic', nodes: [], selections: [], groups: [],
};
const room = (elementId: string, level = 'lv-1') => ({ level, elementId, name: elementId });
const first = room('sp-1');
const second = room('sp-1', 'lv-2');
const stair = room('sp-2');
const lobby = room('sp-3');
const rule = { method: 'equal' as const, recipients: ['101', '102'], factor: 1 as const,
  boundarySource: 'Synthetic boundary', allocationSource: 'Synthetic allocation' };

function fixture() {
  const units = assignSelectedRooms(assignSelectedRooms(empty, [first], '101', false), [second], '102', false);
  return saveRoomAllocation(saveRoomAllocation(units, stair, rule), lobby, { ...rule, recipients: ['101'] });
}

describe('deleting rooms and households', () => {
  it('clears only the scoped room selection and an empty room pool', () => {
    const config = { ...fixture(), confirmed: true };
    const result = removeAreaRooms(config, [first, stair]);
    expect(result.selections.map(item => [item.level, item.elementId])).toEqual([['lv-2', 'sp-1'], ['lv-1', 'sp-3']]);
    expect(result.nodes.map(node => node.id)).toEqual(['101', '102', roomPoolId(lobby)]);
    expect(result.groups.map(group => group.pool)).toEqual([roomPoolId(lobby)]);
    expect(result.confirmed).toBe(false);
    expect(config.selections).toHaveLength(4);
  });

  it('keeps a pool that still has an independent area part', () => {
    const pool = roomPoolId(stair);
    const config: ProjectAreaConfig = { ...fixture(), parts: [
      { id: 'wall-part', owner: pool, kind: 'wall', area: 2, factor: 1, source: 'Synthetic' },
    ] };
    const result = removeAreaRooms(config, [stair]);
    expect(result.nodes.some(node => node.id === pool)).toBe(true);
    expect(result.groups.some(group => group.pool === pool)).toBe(true);
    expect(result.parts).toBe(config.parts);
  });

  it('releases a deleted household’s rooms and clears only its split references', () => {
    const config: ProjectAreaConfig = { ...fixture(), parts: [
      { id: 'wall-part', owner: '101', kind: 'wall', area: 2, factor: 1, source: 'Synthetic' },
    ] };
    const result = removeAreaUnit(config, '101');
    expect(result.nodes.map(node => node.id)).toEqual(['102', roomPoolId(stair), roomPoolId(lobby)]);
    expect(result.parts).toEqual([]);
    expect(result.selections).toHaveLength(3);
    expect(result.groups).toEqual([{ ...config.groups[0], recipients: [{ id: '102' }] }]);
    expect(listCommonRooms(result, [stair, lobby]).map(item => item.group?.pool)).toEqual([roomPoolId(stair), undefined]);
    expect(config.groups).toHaveLength(2);
  });
});
