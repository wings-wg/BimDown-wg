import { describe, expect, it } from 'vitest';
import { inspectPropertyModelEvidence } from './property-model-evidence.js';
import { executeShanghaiPropertyArea } from './shanghai-property.js';

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const polygon = (id: string, ...coordinates: number[][][]) =>
  ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates } });
const collection = (...features: ReturnType<typeof polygon>[]) => JSON.stringify({ type: 'FeatureCollection', features });
const metadata = (units = 'm') => JSON.stringify({ format_version: '2', units, engineering_revision: 'rev-a' });
const lines = (...polylines: number[][][]) => JSON.stringify({ type: 'FeatureCollection',
  features: polylines.map((coordinates, index) =>
    ({ type: 'Feature', properties: { id: `w-${index + 1}` }, geometry: { type: 'LineString', coordinates } })) });

describe('property model evidence', () => {
  it('measures slab unions and deducts only the same-scope hosted opening, preserving existing holes', async () => {
    const files: Record<string, string> = {
      'project_metadata.json': metadata('mm'),
      'global/level.csv': '\ufeffid,name,elevation\r\nlv-1,"一层,图纸名",0\r\nlv-2,屋顶,3000\r\n',
      'lv-1/structure_slab.csv': 'id,function\nss-1,floor\nss-2,floor',
      'lv-1/structure_slab.geojson': collection(polygon('ss-1', rect(0, 0, 8000, 6000), rect(0.5 * 1000, 1000, 1500, 2000)),
        polygon('ss-2', rect(6000, 0, 10000, 6000))),
      'lv-1/opening.csv': 'id,host_id,top_level_id\na,ss-1,\nb,ss-1,\nc,ss-1,\nshaft,,lv-2',
      'lv-1/opening.geojson': collection(polygon('a', rect(500, 1000, 1500, 2000)),
        polygon('b', rect(2000, 1000, 4000, 3000)), polygon('c', rect(3000, 1000, 5000, 3000)),
        polygon('shaft', rect(1000, 3000, 2000, 4000))),
      'lv-2/structure_slab.csv': 'id,function\nss-1,roof',
      'lv-2/structure_slab.geojson': collection(polygon('ss-1', rect(0, 0, 8000, 6000))),
    };
    const read = (path: string) => files[path];
    const report = await inspectPropertyModelEvidence(read);
    expect(report).toMatchObject({ status: 'candidate-only', modelRevision: 'rev-a', inputUnits: 'mm' });
    expect(report.levels[0]).toMatchObject({ name: '一层,图纸名', projectedAreaM2: 59, netProjectionM2: 53 });
    expect(report.levels[0].openings.map(item => item.status))
      .toEqual(['already-in-host-hole', 'hosted-cut', 'hosted-cut', 'cross-level-shaft']);
    expect(report.levels[0].openings[1].host).toEqual({ level: 'lv-1', table: 'structure_slab', id: 'ss-1' });
    expect(report.levels[1]).toMatchObject({ elevationM: 3, roleHint: 'roof-datum-by-name', netProjectionM2: 48 });
    expect(await executeShanghaiPropertyArea(read, JSON.stringify(report))).toMatchObject({ status: 'input-incomplete' });
  });

  it('keeps same-elevation levels distinct and does not cut for ambiguous or missing hosts', async () => {
    const files: Record<string, string> = {
      'project_metadata.json': metadata(),
      'engineering_evidence.json': JSON.stringify({ version: 1, modelRevision: 'old' }),
      'global/level.csv': 'id,name,elevation\nlv-1,一层,0\nlv-2,结构标高,0',
      'lv-1/slab.csv': 'id\np',
      'lv-1/slab.geojson': collection(polygon('p', rect(0, 0, 12, 4))),
      'lv-1/structure_slab.csv': 'id\np',
      'lv-1/structure_slab.geojson': collection(polygon('p', rect(0, 0, 6, 4))),
      'lv-1/opening.csv': 'id,host_id\na,p\nb,ghost',
      'lv-1/opening.geojson': collection(polygon('a', rect(1, 1, 2, 2)), polygon('b', rect(1, 1, 2, 2))),
      'lv-2/space.csv': 'id\nsp-1',
      'lv-2/space.geojson': collection(polygon('sp-1', rect(0, 0, 4, 4))),
    };
    const report = await inspectPropertyModelEvidence(path => files[path]);
    expect(report.diagnostics).toEqual([{ code: 'engineering-revision-mismatch', path: 'engineering_evidence.json' }]);
    expect(report.levels[0]).toMatchObject({ sameElevationLevelIds: ['lv-2'], projectedAreaM2: 48, netProjectionM2: 48 });
    expect(report.levels[0].openings.map(item => item.status)).toEqual(['unresolved-host', 'unresolved-host']);
    expect(report.levels[1]).toMatchObject({ sameElevationLevelIds: ['lv-1'], projectedAreaM2: null, netProjectionM2: null,
      rooms: { rowCount: 1, outlineIds: ['sp-1'] } });
  });

  it('does not substitute zero for invalid or duplicated polygons', async () => {
    const files: Record<string, string> = {
      'project_metadata.json': metadata(),
      'global/level.csv': 'id,elevation\nlv-1,',
      'lv-1/structure_slab.csv': 'id\nss-1\ninvalid\nmissing',
      'lv-1/structure_slab.geojson': collection(polygon('ss-1', rect(0, 0, 5, 5)),
        polygon('ss-1', rect(0, 0, 6, 6)), polygon('invalid', [[0, 0], [5, 4], [0, 4], [5, 0], [0, 0]])),
    };
    const report = await inspectPropertyModelEvidence(path => files[path]);
    expect(report.levels[0]).toMatchObject({ elevationM: null, projectedAreaM2: null, netProjectionM2: null });
    expect(report.levels[0].diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-elevation', 'duplicate-id', 'invalid-surface-polygon', 'missing-surface-polygon', 'no-surface-polygons',
    ]));
  });

  it('uses saved room points and wall geometry without writing outlines or treating them as title evidence', async () => {
    const files: Record<string, string> = {
      'project_metadata.json': metadata('mm'),
      'global/level.csv': 'id,elevation\nlv-1,0\nlv-2,3000',
      'lv-1/space.csv': 'id,name,x,y\nsp-1,一层起居室,1000,2000\nsp-2,甲,6000,2000\nsp-3,乙,7000,2000\nsp-4,室外,12000,2000',
      'lv-1/wall.geojson': lines(rect(0, 0, 10000, 4000), [[0, 3000], [1500, 3000]]),
      'global/structure_wall.csv': 'id,base_level_id,top_level_id\nw-1,lv-1,lv-2',
      'global/structure_wall.geojson': lines([[5000, 0], [5000, 4000]]),
      'lv-2/space.csv': 'id,x,y\nsp-1,1000,1000',
      'lv-2/wall.geojson': lines(rect(0, 0, 4000, 3000), rect(2000, 1000, 3000, 2000)),
    };
    const read = (path: string) => files[path];
    const report = await inspectPropertyModelEvidence(read);
    expect(report.levels[0].rooms).toMatchObject({ rowCount: 4, outlineIds: [], derivedOutlineIds: ['sp-1'],
      sourceFiles: ['lv-1/wall.geojson', 'global/structure_wall.geojson'], needsReviewCount: 3 });
    expect(report.levels[0].rooms.items).toMatchObject([
      { id: 'sp-1', status: 'derived', basis: 'wall-centerline', areaM2: 20, seedM: [1, 2] },
      { id: 'sp-2', status: 'needs-review', areaM2: null, issue: 'shared-room-face' },
      { id: 'sp-3', status: 'needs-review', areaM2: null, issue: 'shared-room-face' },
      { id: 'sp-4', status: 'needs-review', areaM2: null, issue: 'unbounded-room' },
    ]);
    expect(report.levels[1].rooms).toMatchObject({ sourceFiles: ['lv-2/wall.geojson'],
      items: [{ id: 'sp-1', areaM2: null, issue: 'nested-room-face' }] });
    expect(files['lv-1/space.geojson']).toBeUndefined();
    expect(await executeShanghaiPropertyArea(read, JSON.stringify(report))).toMatchObject({ status: 'input-incomplete' });
  });

  it('preserves source semantics and reports orphan, overlapping or displaced saved outlines', async () => {
    const original = polygon('a', rect(0, 0, 5, 5));
    const files: Record<string, string> = {
      'project_metadata.json': metadata(),
      'global/level.csv': 'id,elevation\nlv-1,0',
      'lv-1/space.csv': 'id,x,y\na,1,1\nb,9,1\nc,0,0\nd,25,25',
      'lv-1/space.geojson': collection(original, polygon('b', rect(4, 0, 10, 5)), polygon('c', rect(11, 0, 12, 2)),
        polygon('orphan', rect(4, 4, 6, 6)), { ...polygon('d', rect(20, 20, 31, 30)),
          properties: { id: 'd', ...{ boundary_basis: 'revit-room-finish' } } }),
    };
    const report = await inspectPropertyModelEvidence(path => files[path]);
    expect(report.levels[0].rooms).toMatchObject({ outlineIds: ['d'], orphanOutlineIds: ['orphan'], needsReviewCount: 3,
      items: [
        { id: 'a', areaM2: null, issue: 'overlapping-room-outlines' },
        { id: 'b', areaM2: null, issue: 'overlapping-room-outlines' },
        { id: 'c', areaM2: null, issue: 'seed-outside-saved-outline' },
        { id: 'd', basis: 'revit-room-finish', areaM2: 110 },
      ] });
  });
});
