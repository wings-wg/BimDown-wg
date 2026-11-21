import { describe, expect, it } from 'vitest';
import { applyDoorAssignment, previewDoorAssignment } from './door-assignment.js';
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
