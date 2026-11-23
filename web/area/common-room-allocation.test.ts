import { describe, expect, it } from 'vitest';
import { calculateProjectAreasFromText, type ProjectAreaConfig } from './core/project-input.js';
import { listCommonRooms, roomPoolId, saveRoomAllocation, saveSelectedRoomAllocations, type RoomAllocation } from './common-room-allocation.js';

const space = (elementId: string, name: string, level = 'lv-1') => ({ level, elementId, name });
const stair = space('sp-3', '楼梯间');
const lobby = space('sp-4', '前室');
const unitParts = ['101', '102'].map((owner, index) => ({
  id: `unit-${owner}`, level: 'lv-1', table: 'space',
  elementId: `sp-${index + 1}`, owner, kind: 'usable' as const, factor: 1 as const, source: 'Synthetic boundary',
}));
const config: ProjectAreaConfig = {
  version: 1, confirmed: true, ruleSource: 'Synthetic review',
  nodes: ['101', '102'].map(id => ({ id, type: 'unit', building: 'B1' })),
  groups: [], selections: unitParts,
};
const basis: RoomAllocation = {
  method: 'area', factor: 1, recipients: ['101', '102'],
  boundarySource: 'Synthetic boundary', allocationSource: 'Synthetic allocation',
};

describe('shared area by room', () => {
  it('lists remaining rooms on floors with unit assignments and leaves later door assignment possible', () => {
    const model = [space('sp-1', '一户'), space('sp-2', '二户'), stair, space('sp-3', '其他层', 'lv-2')];
    expect(listCommonRooms({ ...config, selections: [] }, model)).toEqual([]);
    expect(listCommonRooms({ ...config, selections: unitParts.slice(0, 1) }, model).map(item => item.room.name))
      .toEqual(['二户', '楼梯间']);
    expect(listCommonRooms(config, model).map(item => item.room)).toEqual([stair]);
    expect(config.selections).toEqual(unitParts);
  });

  it('calculates independent room rules and edits a rule without duplicating the room', () => {
    const withStair = saveRoomAllocation(config, stair, basis);
    const withLobby = saveRoomAllocation(withStair, lobby, { ...basis, method: 'equal', factor: 0.5 });
    const revised = saveRoomAllocation(withLobby, lobby, { ...basis, method: 'equal', recipients: ['102'] });
    expect(revised.confirmed).toBe(false);
    expect(revised.nodes).toHaveLength(4);
    expect(revised.selections).toHaveLength(4);
    expect(listCommonRooms(revised, [stair, lobby]).map(item => item.group?.pool))
      .toEqual([roomPoolId(stair), roomPoolId(lobby)]);
    const files: Record<string, string> = {
      'project_metadata.json': JSON.stringify({ format_version: '2', units: 'm' }),
      'lv-1/space.geojson': JSON.stringify({ features: [80, 120, 20, 4].map((area, n) => ({
        properties: { id: `sp-${n + 1}` },
        geometry: { type: 'Polygon', coordinates: [[[0, n], [area, n], [area, n + 1], [0, n + 1], [0, n]]] },
      })) }),
    };
    const report = calculateProjectAreasFromText(path => files[path], { ...revised, confirmed: true });
    expect(report.units.map(unit => [unit.id, unit.internalArea, unit.sharedArea])).toEqual([
      ['101', 80, 8], ['102', 120, 16],
    ]);
    expect(report.buildings[0]).toMatchObject({ measuredArea: 224, allocatedArea: 224 });
  });

  it('rejects overwriting a unit room or sharing across buildings', () => {
    expect(() => saveRoomAllocation(config, space('sp-1', '一户'), basis)).toThrow('已有其他归属');
    const multi = { ...config, nodes: [...config.nodes, { id: '301', type: 'unit' as const, building: 'B2' }] };
    expect(() => saveRoomAllocation(multi, stair, { ...basis, recipients: ['101', '301'] })).toThrow('同幢');
  });

  it('configures several pending rooms in one batch with an independent rule for each', () => {
    const result = saveSelectedRoomAllocations(config, [stair, lobby, stair], {
      method: 'equal', allocationSource: 'Batch source', settings: basis,
    });
    expect(result.groups).toEqual([stair, lobby].map(room => ({
      id: roomPoolId(room), pool: roomPoolId(room), method: 'equal',
      source: 'Batch source', recipients: [{ id: '101' }, { id: '102' }],
    })));
    expect(result.selections.slice(2).map(part => [part.elementId, part.factor, part.source]))
      .toEqual([['sp-3', 1, basis.boundarySource], ['sp-4', 1, basis.boundarySource]]);
    expect(result.confirmed).toBe(false);
  });

  it('updates only the allocation method and its source for saved rooms in a mixed batch', () => {
    const landing = space('sp-5', '休息平台');
    const existing = saveRoomAllocation(saveRoomAllocation(config, stair, { ...basis, recipients: ['101'] }),
      lobby, { ...basis, recipients: ['102'], factor: 0.5, boundarySource: 'Lobby boundary' });
    const result = saveSelectedRoomAllocations(existing, [stair, lobby, landing], {
      method: 'equal', allocationSource: 'Reviewed equality',
      settings: { recipients: ['101', '102'], factor: 1, boundarySource: 'Landing boundary' },
    });
    expect(result.selections.slice(0, existing.selections.length)).toEqual(existing.selections);
    expect(result.groups.slice(0, 2)).toEqual(existing.groups.map(group => ({
      ...group, method: 'equal', source: 'Reviewed equality',
    })));
    expect(result.groups[2].recipients).toEqual([{ id: '101' }, { id: '102' }]);
    expect(result.selections.at(-1)).toMatchObject({ elementId: 'sp-5', source: 'Landing boundary' });
  });

  it('rejects the whole batch when a selected pool also measures an unselected room', () => {
    const existing = saveRoomAllocation(config, stair, basis);
    const otherRoom = { ...existing.selections.at(-1)!, id: 'other-room', elementId: 'sp-6' };
    const imported = { ...existing, selections: [...existing.selections, otherRoom] };
    expect(() => saveSelectedRoomAllocations(imported, [lobby, stair], {
      method: 'equal', allocationSource: 'Pending change', settings: basis,
    })).toThrow('存在其他分项');
    expect(imported.groups).toEqual(existing.groups);
    expect(imported.selections.some(item => item.elementId === lobby.elementId)).toBe(false);
  });
});
