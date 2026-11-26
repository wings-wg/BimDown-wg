import { describe, expect, it } from 'vitest';
import { inspectPropertyModelEvidence } from './core/property-model-evidence.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import { activeBoundaryRecords, createBoundaryRecord, makeBoundaryScope, readBoundaryReview, storeBoundaryRecord } from './property-boundary-review.js';
import { currentPropertyRoomUse, reviewPropertyRoomUse } from './property-room-use.js';

const rectangle = (left: number, right: number) => ({
  type: 'Polygon', coordinates: [[[left, 0], [right, 0], [right, 2], [left, 2], [left, 0]]],
});
const assignments: ProjectAreaConfig = {
  version: 1, confirmed: false, ruleSource: '合成算例',
  nodes: [{ id: '101', type: 'unit', building: 'B1' }, { id: '102', type: 'unit', building: 'B1' },
    { id: '201', type: 'unit', building: 'B2' }], groups: [],
  commonRoomDrafts: [{ level: 'lv-1', elementId: 'sp-2', source: '入户门预览' }],
  selections: [{ id: '1', level: 'lv-1', table: 'space', elementId: 'sp-1', kind: 'usable', owner: '101', factor: 1, source: '确认归户' }],
};

async function scopes(right = 2, units = 'm') {
  const files = new Map<string, string>([
    ['project_metadata.json', JSON.stringify({ format_version: '2', units, engineering_revision: 'export-1' })],
    ['global/level.csv', 'id,name,elevation\nlv-1,F1,0\nlv-2,F2,3'],
  ]);
  for (const level of ['lv-1', 'lv-2']) {
    files.set(`${level}/space.csv`, 'id,name,x,y\nsp-1,客厅,1,1\nsp-2,走道,3,1');
    files.set(`${level}/space.geojson`, JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { id: 'sp-1', boundary_basis: 'wall-centerline' }, geometry: rectangle(0, right) },
      { type: 'Feature', properties: { id: 'sp-2' }, geometry: rectangle(2, 4) },
    ] }));
  }
  const evidence = await inspectPropertyModelEvidence(path => files.get(path));
  return Promise.all(evidence.levels.map(level => makeBoundaryScope(evidence, level, assignments)));
}

describe('candidate boundary review', () => {
  it('retains original and adjusted geometry, limits records to the scoped level and honors changed candidates', async () => {
    const [first, second] = await scopes();
    expect(first.rooms.map(room => room.group.kind)).toEqual(['unit', 'common']);
    expect(second.rooms.map(room => room.group.kind)).toEqual(['unassigned', 'unassigned']);
    const file = readBoundaryReview(null);
    const record = createBoundaryRecord(first, file, 'sp-1', 'adjust', '复核墙线', JSON.stringify(rectangle(0.5, 2)));
    expect(record.original).toMatchObject({ path: 'lv-1/space.geojson', areaM2: 4, basis: 'wall-centerline' });
    expect(record.reviewed?.areaM2).toBe(3);
    const stored = readBoundaryReview(JSON.stringify(storeBoundaryRecord(file, record)));
    expect(activeBoundaryRecords(stored, first).get('sp-1')).toEqual(record);
    expect(activeBoundaryRecords(stored, second).size).toBe(0);
    const [changed] = await scopes(1.75);
    expect(activeBoundaryRecords(stored, changed).size).toBe(0);
    const revised = createBoundaryRecord(changed, stored, 'sp-1', 'keep', '复核新模型', '');
    expect(storeBoundaryRecord(stored, revised).records).toHaveLength(2);
    expect(storeBoundaryRecord(stored, record).records).toHaveLength(1);
  });

  it('blocks invalid geometry, loss of the room seed and overlap, while allowing a deferred record', async () => {
    const [first] = await scopes();
    const file = readBoundaryReview(null);
    expect(() => createBoundaryRecord(first, file, 'sp-1', 'adjust', '测试', '{}')).toThrow('有效的 GeoJSON');
    expect(() => createBoundaryRecord(first, file, 'sp-1', 'adjust', '测试', JSON.stringify(rectangle(1.1, 2)))).toThrow('定位点');
    expect(() => createBoundaryRecord(first, file, 'sp-1', 'adjust', '测试', JSON.stringify(rectangle(0, 2.5)))).toThrow('重叠');
    expect(createBoundaryRecord(first, file, 'sp-1', 'defer', '需要原图', '').reviewed).toBeNull();
  });

  it('reviews common scope with same-building recipients and supports both kinds of deductions', async () => {
    const [first] = await scopes();
    const blank = readBoundaryReview(null);
    const room = createBoundaryRecord(first, blank, 'sp-2', 'keep', '核对走道', '');
    const input = { kind: 'allocatable', building: 'B1', scope: 'whole-building', recipients: [], source: '幢内共用' } as const;
    const whole = reviewPropertyRoomUse(room, assignments, { ...input, recipients: [] });
    const result = readBoundaryReview(JSON.stringify(storeBoundaryRecord(blank, whole))).records[0];
    expect(result.propertyUse?.recipients).toEqual(['101', '102']);
    expect(reviewPropertyRoomUse(room, assignments, { ...input, scope: 'selected-units', recipients: ['102'] })
      .propertyUse.recipients).toEqual(['102']);
    expect(() => reviewPropertyRoomUse(room, assignments, { ...input, scope: 'selected-units', recipients: ['201'] }))
      .toThrow('本幢受益户');
    expect(() => reviewPropertyRoomUse(room, assignments, { ...input, scope: 'selected-units', recipients: ['102', '102'] }))
      .toThrow('本幢受益户');
    for (const kind of ['independent-use', 'non-allocatable'] as const) {
      expect(reviewPropertyRoomUse(room, assignments, { ...input, kind, scope: 'none', recipients: [] })
        .propertyUse).toMatchObject({ kind, recipients: [], scope: 'none' });
    }
  });

  it('demands a reviewed boundary and invalidates the use when the boundary or eligible roster changes', async () => {
    const [first] = await scopes();
    const blank = readBoundaryReview(null);
    const room = createBoundaryRecord(first, blank, 'sp-1', 'keep', '核对套内', '');
    const input = { kind: 'private', building: 'B1', scope: 'none', recipients: [], source: '权属图' } as const;
    const reviewed = reviewPropertyRoomUse(room, assignments, { ...input, recipients: [] });
    const file = storeBoundaryRecord(blank, reviewed);
    expect(reviewed.propertyUse.recipients).toEqual(['101']);
    expect(currentPropertyRoomUse(reviewed, { ...assignments, nodes: assignments.nodes.filter(node => node.id !== '102') })).toBeUndefined();
    expect(createBoundaryRecord(first, file, 'sp-1', 'keep', '补充依据', '').propertyUse).toEqual(reviewed.propertyUse);
    expect(createBoundaryRecord(first, file, 'sp-1', 'adjust', '复核新轮廓', JSON.stringify(rectangle(0.5, 2))).propertyUse)
      .toBeUndefined();
    const deferred = createBoundaryRecord(first, file, 'sp-1', 'defer', '缺图', '');
    expect(() => reviewPropertyRoomUse(deferred, assignments, { ...input, recipients: [] })).toThrow('可用的房间边界');
    expect(() => reviewPropertyRoomUse(room, assignments, { ...input, kind: 'non-allocatable', recipients: [] })).toThrow('冲突');
  });
});
