import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { executeShanghaiPropertyArea, inspectShanghaiPropertyArea, type ShanghaiPropertyPlan } from './shanghai-property.js';
import { calculateShanghaiPropertyProject } from './project.js';

const dir = fileURLToPath(new URL('../../../sample_data/shanghai-property-example/', import.meta.url));
const files = () => new Map(['project_metadata.json', 'property_area.json', 'lv-1/property_boundary.geojson']
  .map(path => [path, readFileSync(join(dir, path), 'utf8')]));
const parse = (data: Map<string, string>): ShanghaiPropertyPlan => JSON.parse(data.get('property_area.json')!);
const run = (data: Map<string, string>, input?: object, reviewed = true) =>
  executeShanghaiPropertyArea(path => data.get(path), input && JSON.stringify(input), reviewed);

describe('Shanghai 2022 reviewed single-building difference method', () => {
  it('deducts the independent space, includes balcony eligible area and preserves directory and ZIP results', async () => {
    const data = files();
    const directory = await calculateShanghaiPropertyProject(dir);
    expect(directory).toMatchObject({ status: 'success',
      reconciliation: { adoptedGross: 260, adoptedDeductions: 20, denominator: 200, shared: 40, coefficient: 0.2,
        reportRoundingDifference: 0 },
      units: [{ id: 'A', internalArea: 80, sharedArea: 16, totalArea: 96,
        parts: [{ rawArea: 77 }, { rawArea: 6, countedArea: 3 }] },
      { id: 'B', internalArea: 120, sharedArea: 24, totalArea: 144 }],
    });
    const scratch = mkdtempSync(join(tmpdir(), 'bimdown-sh-property-'));
    try {
      const path = join(scratch, 'project.bimdown');
      writeFileSync(path, zipSync(Object.fromEntries([...data].map(([key, value]) => [key, strToU8(value)]))));
      expect(await calculateShanghaiPropertyProject(path)).toEqual(directory);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('leaves missing evidence, out-of-date data and historical business branches pending', async () => {
    const data = files();
    const input = parse(data);
    data.delete('property_area.json');
    expect(await run(data)).toMatchObject({ status: 'input-incomplete', diagnostics: [
      { field: 'property_area.json' }, { field: 'gross / units' }, { field: 'common / deductions' },
    ] });
    expect(await run(data, { ...input, modelRevision: 'old' })).toMatchObject({ diagnostics: [{ field: 'modelRevision' }] });
    expect(await run(data, { ...input, business: { ...input.business, type: 'historical-prediction' } }))
      .toMatchObject({ diagnostics: [{ kind: 'unsupported', field: 'business' }] });
    expect(await run(data, input, false)).toMatchObject({ diagnostics: [{ kind: 'needs-review', field: 'review' }] });
  });

  it('checks the same evidence and ledger before approval without producing any allocation', async () => {
    const data = files();
    const read = (path: string) => data.get(path);
    const draft = { ...parse(data), review: { confirmed: false, source: '' } };
    const check = (input: object) => inspectShanghaiPropertyArea(read, JSON.stringify(input));
    const ready = await check(draft);
    expect(ready).toMatchObject({ status: 'ready-for-review', unitCount: 2, hasReviewSource: false });
    expect(ready).not.toHaveProperty('units');
    expect(ready).not.toHaveProperty('reconciliation');
    expect(await run(data, draft)).toMatchObject({ status: 'input-incomplete', diagnostics: [{ field: 'review' }] });
    expect(await check({ ...draft, deductions: [] })).toMatchObject({ diagnostics: [{ kind: 'conflict', field: 'common' }] });
    expect(await check({ ...draft, modelRevision: 'old' })).toMatchObject({ diagnostics: [{ field: 'modelRevision' }] });
    data.delete('lv-1/property_boundary.geojson');
    expect(await check(draft)).toMatchObject({ diagnostics: [{ kind: 'missing-data', field: 'lv-1/property_boundary.geojson' }] });
    data.delete('property_area.json');
    expect(await inspectShanghaiPropertyArea(read)).toMatchObject({ diagnostics: [{ field: 'property_area.json' }, {}, {}] });
  });

  it('rejects conflicting ledger, beneficiary scope and reuse of a boundary', async () => {
    const data = files();
    const input = parse(data);
    expect(await run(data, { ...input, deductions: [] })).toMatchObject({ diagnostics: [{ field: 'common' }] });
    expect(await run(data, { ...input, common: { ...input.common, beneficiaryUnitIds: ['A', 'A'] } }))
      .toMatchObject({ diagnostics: [{ field: 'common.beneficiaryUnitIds' }] });
    input.units[0].parts.push({ ...input.units[0].parts[0], id: 'a-duplicate' });
    expect(await run(data, input)).toMatchObject({ diagnostics: [{ field: 'a-duplicate', kind: 'conflict' }] });
  });

  it('rejects a scope with overlapping, incompatible or invalid polygons', async () => {
    const data = files();
    const path = 'lv-1/property_boundary.geojson';
    const original = data.get(path)!;
    for (const conflict of ['overlap', 'frame', 'hole', 'revision']) {
      const geo = JSON.parse(original);
      if (conflict === 'overlap') geo.features[1].geometry.coordinates[0] = [[7,0],[9,0],[9,3],[7,3],[7,0]];
      if (conflict === 'frame') geo.features[1].properties.frame = 'other-frame';
      if (conflict === 'hole') geo.features[0].geometry.coordinates[1] = [[20,20],[20,21],[21,21],[21,20],[20,20]];
      if (conflict === 'revision') geo.modelRevision = 'stale-boundary';
      data.set(path, JSON.stringify(geo));
      expect((await run(data)).status).toBe('input-incomplete');
    }
  });

  it('reports rounding residue separately and rounds a half-cent ratio upward', async () => {
    const data = files();
    const input = parse(data);
    input.units = ['A', 'B', 'C'].map(id => ({ id, ownershipSource: '合成权属', parts: [
      { id: `p-${id}`, basis: 'unit-wall-centerline', areaM2: 1, source: '合成面积' },
    ] }));
    input.gross.areaM2 = 3.01;
    input.deductions = [];
    input.common.parts = [{ id: 'shared-1', basis: 'common-wall-centerline', source: '合成台账', areaM2: 0.01 }];
    input.common.beneficiaryUnitIds = ['A', 'B', 'C'];
    expect(await run(data, input)).toMatchObject({ status: 'success',
      reconciliation: { shared: 0.01, distributed: 0, reportRoundingDifference: -0.01 } });
    input.units.pop();
    input.gross.areaM2 = 2.01;
    input.common.beneficiaryUnitIds.pop();
    expect(await run(data, input)).toMatchObject({ status: 'success',
      reconciliation: { shared: 0.01, distributed: 0.02, reportRoundingDifference: 0.01 } });
  });
});
