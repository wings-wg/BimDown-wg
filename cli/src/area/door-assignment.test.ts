import { describe, expect, it } from 'vitest';
import { applyDoorAssignment, applyFloorDoorAssignments, previewDoorAssignment, type FloorDoorAssignmentPreview } from './door-assignment.js';
import { calculateProjectAreasFromText, type ProjectAreaConfig } from './project-input.js';

const blank: ProjectAreaConfig = { version: 1, confirmed: true, ruleSource: 'Synthetic', nodes: [], selections: [], groups: [] };
const entry = { level: 'lv-1', elementId: 'd-1' };
const link = (doorUuid: string, targetRoomUuid: string | null, isUnitEntrance = false) =>
  ({ doorUuid, targetRoomUuid, isUnitEntrance, relation: targetRoomUuid ? 'door_adjacency' : 'unresolved_or_exterior' });
const room = (uuid: string, id: string, connections: ReturnType<typeof link>[], isCommon = false) =>
  ({ uuid, id, name: uuid, phaseUuid: 'phase-1', connections, isCommon });
const mapping = (uuid: string, id: string, directory = 'lv-1') => ({ uuid, id, directory });
const fixture = () => ({
  evidence: {
    version: 1,
    rooms: [
      room('hall', 'sp-1', [link('entry', 'living'), link('neighbour-door', 'neighbour')], true),
      room('living', 'sp-2', [link('entry', 'hall'), link('living-bedroom', 'bedroom'), link('back-door', 'neighbour', true)]),
      room('bedroom', 'sp-3', [link('living-bedroom', 'living')]),
      room('neighbour', 'sp-4', [link('neighbour-door', 'hall'), link('back-door', 'living', true)]),
      room('other-level', 'sp-1', []),
    ],
  },
  mappings: [
    mapping('entry', 'd-1'), mapping('another-door', 'd-1', 'lv-2'),
    mapping('hall', 'sp-1'), mapping('living', 'sp-2'), mapping('bedroom', 'sp-3'), mapping('neighbour', 'sp-4'),
    mapping('other-level', 'sp-1', 'lv-2'),
  ],
});

describe('room assignment from an entrance', () => {
  it('records geometric provenance when saving an editor room assignment', () => {
    const { evidence, mappings } = fixture();
    const preview = { ...previewDoorAssignment(evidence, mappings, entry, blank), source: 'floor-plan' as const };
    const config = applyDoorAssignment(blank, preview, preview.candidates[0], '101');
    expect(config.selections[0].source).toContain('网页平面几何推断；入户门 lv-1/door/d-1');
    expect(config.selections.map(part => part.elementId)).toEqual(['sp-2', 'sp-3']);
    expect(config.confirmed).toBe(false);
  });

  it('records the public side as pending without creating measurement parts or overwriting any unit', () => {
    const { evidence, mappings } = fixture();
    const hall = { level: 'lv-1', elementId: 'sp-1', uuid: 'hall', name: '楼梯间' };
    const preview = { ...previewDoorAssignment(evidence, mappings, entry, blank), source: 'floor-plan' as const,
      publicSide: { rooms: [hall], anchors: [hall], warnings: [] } };
    const config = applyDoorAssignment(blank, preview, preview.candidates[0], '101');
    expect(config.commonRoomDrafts).toEqual([{ level: 'lv-1', elementId: 'sp-1',
      source: expect.stringContaining('公共交通空间 lv-1/space/sp-1') }]);
    expect(config.selections.map(part => part.elementId)).toEqual(['sp-2', 'sp-3']);
    expect(config.groups).toEqual([]);
    expect(applyDoorAssignment(config, preview, preview.candidates[0], '101')).toEqual(config);
    const conflict = { ...config, selections: [...config.selections, { ...config.selections[0], elementId: 'sp-1' }] };
    expect(() => applyDoorAssignment(conflict, preview, preview.candidates[0], '101')).toThrow('公共侧的房间');
  });

  it('applies a whole floor once, retaining shared evidence and blocking a conflicting batch', () => {
    const privateRooms = ['sp-2', 'sp-3'].map(elementId =>
      ({ level: entry.level, elementId, uuid: elementId, name: elementId }));
    const batch: FloorDoorAssignmentPreview = {
      level: entry.level,
      commonAreas: [{ doorIds: ['d-1', 'd-2'], rooms: [{ ...privateRooms[0], elementId: 'sp-1', uuid: 'hall' }] }],
      households: privateRooms.map((inside, index) =>
        ({ doorId: `d-${index + 1}`, commonArea: 0, candidate: { inside, rooms: [inside], warnings: [] } })),
    };
    const numbers = new Map([['d-1', '101'], ['d-2', '102']]);
    const config = applyFloorDoorAssignments(blank, batch, numbers);
    expect(config.selections.map(item => [item.owner, item.elementId])).toEqual([['101', 'sp-2'], ['102', 'sp-3']]);
    expect(config.commonRoomDrafts).toEqual([{ level: entry.level, elementId: 'sp-1',
      source: expect.stringContaining('共同连通的入户门 lv-1/door/d-1、lv-1/door/d-2') }]);
    expect(applyFloorDoorAssignments(config, batch, numbers)).toEqual(config);
    expect(() => applyFloorDoorAssignments(blank, batch, new Map([['d-1', '101'], ['d-2', ' 101 ']]))).toThrow('户号不能重复');
    const conflict = { ...blank, nodes: [{ ...config.nodes[1], id: '103' }],
      selections: [{ ...config.selections[1], owner: '103' }] };
    const snapshot = structuredClone(conflict);
    expect(() => applyFloorDoorAssignments(conflict, batch, numbers)).toThrow('已有其他归属');
    expect(conflict).toEqual(snapshot);
  });

  it('reports an empty room export before checking the door scope', () => {
    expect(() => previewDoorAssignment({ version: 1, rooms: [] }, [], entry, blank)).toThrow('没有房间记录');
  });

  it('assigns only the connected private rooms and uses the resulting config for measurement', () => {
    const { evidence, mappings } = fixture();
    const preview = previewDoorAssignment(evidence, mappings, entry, blank);
    expect(preview.doorUuid).toBe('entry');
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0].rooms.map(item => item.uuid)).toEqual(['living', 'bedroom']);
    const config = applyDoorAssignment(blank, preview, preview.candidates[0], '101');
    expect(config.confirmed).toBe(false);
    expect(config.selections[0].source).toContain('lv-1/door/d-1');
    expect(blank.selections).toHaveLength(0);
    expect(applyDoorAssignment(config, preview, preview.candidates[0], '101').selections).toHaveLength(2);

    const footprints = [10, 4].map((width, index) => ({
      properties: { id: `sp-${2 + index}` },
      geometry: { type: 'Polygon', coordinates: [[[0, index], [width, index], [width, index + 1], [0, index + 1], [0, index]]] },
    }));
    const files: Record<string, string> = {
      'project_metadata.json': '{"format_version":"2","units":"m"}',
      'lv-1/space.geojson': JSON.stringify({ features: footprints }),
    };
    const report = calculateProjectAreasFromText(path => files[path], { ...config, confirmed: true });
    expect(report.units[0]).toMatchObject({ id: '101', internalArea: 14, totalArea: 14 });
  });

  it('requires a choice between viable sides and stops cross-floor traversal', () => {
    const { evidence, mappings } = fixture();
    evidence.rooms[0].isCommon = false;
    evidence.rooms[2].connections.push(link('stairs', 'other-level'));
    evidence.rooms[4].connections.push(link('stairs', 'bedroom'));
    const preview = previewDoorAssignment(evidence, mappings, entry, blank);
    expect(preview.candidates.map(candidate => candidate.inside.uuid)).toEqual(['hall', 'living']);
    expect(preview.candidates[1].rooms.map(item => item.uuid)).toEqual(['living', 'bedroom']);
    expect(preview.candidates[1].warnings).toEqual([expect.stringContaining('跨层')]);
  });

  it('rejects ambiguous legacy door scope and a path that reconnects both sides', () => {
    const { evidence, mappings } = fixture();
    expect(() => previewDoorAssignment(evidence, [...mappings, mapping('duplicate', 'd-1')], entry, blank))
      .toThrow('_IdMap.csv');
    evidence.rooms[0].isCommon = false;
    evidence.rooms[1].connections[2].isUnitEntrance = false;
    evidence.rooms[3].connections[1].isUnitEntrance = false;
    expect(() => previewDoorAssignment(evidence, mappings, entry, blank)).toThrow('两侧仍可通过其他门相通');
  });

  it('reports unresolved evidence and does not overwrite rooms already assigned to another unit', () => {
    const { evidence, mappings } = fixture();
    evidence.rooms[0].connections.shift();
    evidence.rooms[1].connections[0] = link('entry', null);
    evidence.rooms[1].connections.push(link('unknown', null));
    const preview = previewDoorAssignment(evidence, mappings, entry, blank);
    expect(preview.candidates[0].warnings).toHaveLength(2);
    const config = applyDoorAssignment(blank, preview, preview.candidates[0], '101');
    expect(() => applyDoorAssignment(config, preview, preview.candidates[0], '102')).toThrow('已有其他归属');
    expect(config.selections.every(item => item.owner === '101')).toBe(true);
  });
});
