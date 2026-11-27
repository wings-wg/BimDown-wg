import { describe, expect, it } from 'vitest';
import { inspectPropertyModelEvidence } from './core/property-model-evidence.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import { createBoundaryRecord, makeBoundaryScope, readBoundaryReview, storeBoundaryRecord } from './property-boundary-review.js';
import { reconcilePropertyBuilding } from './property-building-ledger.js';
import { reviewPropertyRoomUse, type PropertyRoomUseInput } from './property-room-use.js';

const config: ProjectAreaConfig = {
  version: 1, confirmed: false, ruleSource: '合成算例', groups: [],
  nodes: [{ id: '101', type: 'unit', building: 'B1' }, { id: '201', type: 'unit', building: 'B1' },
    { id: 'B2-201', type: 'unit', building: 'B2' }],
  selections: [['lv-1', 'room', '101'], ['lv-2', 'room', '201'], ['lv-2', 'other', 'B2-201']]
    .map(([level, elementId, owner]) => ({ id: `${level}/${elementId}`, level, table: 'space', elementId,
      kind: 'usable', owner, factor: 1, source: '归户复核' })),
};
const input = { building: 'B1', levelIds: ['lv-1', 'lv-2'], scopeConfirmed: true,
  gross: { areaM2: 64, source: ' 独立量测报告 ' } };

async function fixture(secondElevation = 3000) {
  const files = new Map([
    ['project_metadata.json', JSON.stringify({ format_version: 2, units: 'mm', engineering_revision: 'sample-1' })],
    ['global/level.csv', `id,name,elevation\nlv-1,F1,0\nlv-2,F2,${secondElevation}`],
  ]);
  const floors = [
    { id: 'lv-1', rooms: [['room', 20], ['common', 5], ['deduction', 2]] as const },
    { id: 'lv-2', rooms: [['room', 30], ['common', 3], ['deduction', 4], ['other', 7]] as const },
  ];
  for (const { id, rooms } of floors) {
    files.set(`${id}/space.csv`, 'id,name\n' + rooms.map(([room]) => `${room},${room}`).join('\n'));
    files.set(`${id}/space.geojson`, JSON.stringify({
      type: 'FeatureCollection', features: rooms.map(([room, width], index) => {
        const x = index * 50000, right = x + width * 1000;
        return { type: 'Feature', properties: { id: room, boundary_basis: 'wall-centerline' },
          geometry: { type: 'Polygon', coordinates: [[[x, 0], [right, 0], [right, 1000], [x, 1000], [x, 0]]] } };
      }),
    }));
  }
  const evidence = await inspectPropertyModelEvidence(path => files.get(path));
  let file = readBoundaryReview(null);
  for (const level of evidence.levels) {
    const scope = await makeBoundaryScope(evidence, level, config);
    const first = level.id === 'lv-1';
    for (const room of scope.rooms.filter(room => room.id !== 'other')) {
      const boundary = createBoundaryRecord(scope, file, room.id, 'keep', '边界复核', '');
      const kind = room.id === 'room' ? 'private' : room.id === 'common' ? 'allocatable'
        : first ? 'independent-use' : 'non-allocatable';
      const use: PropertyRoomUseInput = { kind, building: 'B1', source: '用途复核',
        scope: kind !== 'allocatable' ? 'none' : first ? 'whole-building' : 'selected-units',
        recipients: kind === 'allocatable' && !first ? ['201'] : [] };
      file = storeBoundaryRecord(file, reviewPropertyRoomUse(boundary, config, use));
    }
  }
  return { evidence, file: readBoundaryReview(JSON.stringify(file)) };
}

describe('candidate building register', () => {
  it('reconciles two floors with reused short IDs, converted units and both deduction kinds', async () => {
    const { evidence, file } = await fixture();
    const result = await reconcilePropertyBuilding(evidence, file, config, input);
    expect(result.status).toBe('balanced');
    expect(result.issues).toEqual([]);
    expect(result.gross).toEqual({ areaM2: 64, source: '独立量测报告' });
    expect(result.unitAreas).toEqual([{ id: '101', areaM2: 20 }, { id: '201', areaM2: 30 }]);
    expect(result.totals).toEqual({ privateM2: 50, nonAllocatableM2: 4, independentUseM2: 2, commonM2: 8, selectedUnitCommonM2: 3 });
    expect(result.comparison).toEqual({ rawResidualM2: 8, residualM2: 8, commonM2: 8, differenceM2: 0 });
    expect(result.hasSelectedUnitCommon).toBe(true);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.find(row => row.level === 'lv-2' && row.roomId === 'common')?.review.propertyUse.recipients).toEqual(['201']);
  });

  it('compares at 0.01 m² after summing and blocks negative or unequal residuals', async () => {
    const { evidence, file } = await fixture();
    const run = (areaM2: number) => reconcilePropertyBuilding(evidence, file, config, { ...input, gross: { ...input.gross, areaM2 } });
    expect((await run(64.004)).status).toBe('balanced');
    expect(await run(64.005)).toMatchObject({ status: 'conflict', comparison: { differenceM2: 0.01 } });
    expect(await run(55)).toMatchObject({ status: 'conflict', comparison: { differenceM2: -9 } });
  });

  it('keeps partial totals and reports missing evidence and omitted floors with their addresses', async () => {
    const { evidence, file } = await fixture();
    file.records = file.records.filter(record => record.roomId !== 'common');
    const result = await reconcilePropertyBuilding(evidence, file, config, {
      ...input, levelIds: ['lv-1'], scopeConfirmed: false, gross: { areaM2: 64, source: '  ' },
    });
    expect(result.status).toBe('pending');
    expect(result.comparison).toBeNull();
    expect(result.totals).toMatchObject({ privateM2: 20, commonM2: null, nonAllocatableM2: null });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unconfirmed-level-scope' }),
      expect.objectContaining({ code: 'missing-independent-gross' }),
      expect.objectContaining({ code: 'omitted-building-level', level: 'lv-2' }),
      expect.objectContaining({ code: 'unreviewed-room', level: 'lv-1', roomId: 'common' }),
      expect.objectContaining({ code: 'missing-private-parts', message: expect.stringContaining('201') }),
    ]));
  });

  it('rejects duplicate floor datums, invalidated rosters, and duplicate room assignments', async () => {
    const { evidence, file } = await fixture(0);
    const revised = { ...config, nodes: [...config.nodes, { id: '102', type: 'unit' as const, building: 'B1' }],
      selections: [...config.selections, config.selections[0]] };
    const result = await reconcilePropertyBuilding(evidence, file, revised, input);
    expect(result.status).toBe('pending');
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous-level-datum', level: 'lv-1' }),
      expect.objectContaining({ code: 'duplicate-assignment', level: 'lv-1', roomId: 'room' }),
      expect.objectContaining({ code: 'unreviewed-room', level: 'lv-2', roomId: 'common' }),
    ]));
  });

  it('withholds reconciliation when imported room reviews count the same geometry twice', async () => {
    const { evidence, file } = await fixture();
    const firstFloor = file.records.filter(record => record.level === 'lv-1');
    const common = firstFloor.find(record => record.roomId === 'common')!;
    common.reviewed = firstFloor.find(record => record.roomId === 'room')!.reviewed;
    const result = await reconcilePropertyBuilding(evidence, readBoundaryReview(JSON.stringify(file)), config, input);
    expect(result.status).toBe('pending');
    expect(result.comparison).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'overlapping-reviewed-rooms', level: 'lv-1', roomId: 'common' }));
  });
});
