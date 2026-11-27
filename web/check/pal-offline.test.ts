import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { bindPalPlan, importJsonRules } from './check-import.js';
import { readCheckLevels, runModelCheck } from './check-model.js';
import { offlineCompilationInput, offlineModel, offlineRules } from './pal-offline-fixture.js';
import { validatePalResponse } from './pal-plan.js';
import { suggestStoreyChoices } from './storey-height.js';
import { compareModelCheckReports, readComparisonBaseline } from './report-comparison.js';
import { TOOL_PROFILES, toolId, type ToolRecipe } from './core/tool-recipes.js';

const reader = (files: Map<string, string>) => ({ fetchText: async (path: string) => files.get(path) ?? null });
const evidencePath = 'engineering_evidence.json';
const statuses = (report: Awaited<ReturnType<typeof runModelCheck>>, id: string) =>
  Object.fromEntries(report.results.filter(row => row.ruleId === id).map(row => [row.object ? `${row.object.scope}/${row.object.id}` : '-', row.status]));

async function replay(files: Map<string, string>, confirmLevels = false, items = offlineRules()) {
  const ds = reader(files);
  const { levels, raw } = await readCheckLevels(ds);
  const choices = confirmLevels ? suggestStoreyChoices(levels) : new Map();
  if (confirmLevels) choices.set('lv-3', { mode: 'excluded' });
  return runModelCheck(ds, items, choices, raw);
}

describe('offline BIMDown PAL benchmark', () => {
  it('tracks 97 original rows and compares only rerun rules by scoped object', async () => {
    const originals = offlineRules();
    const items = [...originals, ...Array.from({ length: 91 }, (_, i) => ({
      id: `P-${i + 1}`, title: '待编译原文', source: { document: '合成工作簿', locator: `规则表!第${i + 8}行`, text: '原条款' },
      reason: '等待 PAL 编译',
    }))];
    const baseline = await replay(offlineModel('baseline'), false, items);
    expect(baseline.clauseTrace).toHaveLength(97);
    expect(baseline.clauseTrace.filter(item => item.status === 'pending')).toHaveLength(91);
    expect(baseline.clauseTrace[96].source.locator).toBe('规则表!第98行');
    const rerun = await replay(offlineModel('complete'), false, items.filter(item => item.id === 'JG-03'));
    const downloaded = JSON.parse(JSON.stringify(baseline));
    const comparison = compareModelCheckReports(readComparisonBaseline(downloaded, items), rerun);
    expect(() => readComparisonBaseline(downloaded, items.slice(1))).toThrow(/不符/);
    expect(comparison.rules).toEqual(['JG-03']);
    expect(comparison.beforeModelVersion).not.toBe(comparison.afterModelVersion);
    expect(comparison.runs[0]).toMatchObject({ newExecution: false,
      changes: { plan: false, evidence: true, review: false },
      before: { tool: { version: 1 } }, after: { tool: { version: 1 } } });
    expect(comparison.changes).toHaveLength(3);
    expect(comparison.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ object: { scope: 'lv-1', table: 'structure_slab', id: 's-1' }, before: 'indeterminate', after: 'pass' }),
      expect.objectContaining({ object: { scope: 'lv-2', table: 'structure_slab', id: 's-1' }, before: 'indeterminate', after: 'fail' }),
    ]));
  });

  it('keeps per-clause fingerprints stable across a selective rerun and detects a version change on the same objects', async () => {
    const items = offlineRules();
    const files = offlineModel('complete');
    const storey = items.find(item => item.id === 'JT-01')!;
    const baseline = await replay(files, true, items);
    const partial = await replay(files, true, [storey]);
    const unchanged = compareModelCheckReports(baseline, partial);
    expect(unchanged.beforeModelVersion).not.toBe(unchanged.afterModelVersion);
    expect(unchanged.runs[0].changes).toEqual({ plan: false, evidence: false, review: false });
    expect(unchanged.changes).toEqual([]);

    const changed = await replay(files, true, [{ ...storey, rule: { ...storey.rule!, version: 'review-2', threshold: 3.1 } }]);
    const comparison = compareModelCheckReports(baseline, changed);
    expect(comparison.runs[0]).toMatchObject({ before: { ruleVersion: storey.rule!.version }, after: { ruleVersion: 'review-2' },
      changes: { plan: true, evidence: false, review: false } });
    expect(comparison.changes).toEqual([
      expect.objectContaining({ object: { scope: 'global', table: 'level', id: 'lv-1' }, before: 'pass', after: 'fail' }),
    ]);

    const legacy = { ...baseline, clauseTrace: baseline.clauseTrace.map(({ id, source }) => ({ id, source })) };
    expect(compareModelCheckReports(readComparisonBaseline(legacy, items), partial).runs[0].changes).toBeNull();
    expect(() => readComparisonBaseline({ ...baseline, results: [...baseline.results, baseline.results[0]] }, items)).toThrow(/重复/);
  });

  it('distinguishes local review from file changes and reports changed blockers without a status change', async () => {
    const files = offlineModel('complete');
    const storey = offlineRules().filter(item => item.id === 'JT-01');
    const baseline = await replay(files, false, storey);
    const reviewed = await replay(files, true, storey);
    expect(compareModelCheckReports(baseline, reviewed).runs[0].changes)
      .toEqual({ plan: false, evidence: false, review: true });

    const slab = offlineRules().filter(item => item.id === 'JG-03');
    const missing = await replay(offlineModel('baseline'), false, slab);
    const stale = await replay(offlineModel('stale'), false, slab);
    const comparison = compareModelCheckReports(missing, stale);
    expect(comparison.runs[0].changes).toEqual({ plan: false, evidence: true, review: false });
    expect(comparison.changes).toContainEqual(expect.objectContaining({
      before: 'indeterminate', after: 'indeterminate', afterBlockers: expect.arrayContaining(['invalid-evidence']),
    }));
    const firstExecution = compareModelCheckReports({ ...missing, results: [] }, stale);
    expect(firstExecution.runs[0].newExecution).toBe(true);
  });

  it('records a tool change even if all results stay stable', async () => {
    const files = offlineModel('complete');
    const item = offlineRules().find(rule => rule.id === 'JG-03')!;
    const tool = item.libraryTool!;
    const concept = 'slab.cast-in-place-solid-structural-thickness';
    const fields = TOOL_PROFILES[concept].inputs;
    const recipe: ToolRecipe = { concept, operation: 'difference', inputs: [fields.upper, fields.lower] };
    const evidence = JSON.parse(files.get(evidencePath)!) as {
      measurements: { object: { scope: string }; concept: string; value: number }[];
    };
    const elevations = evidence.measurements.filter(row => row.concept === concept).flatMap(row => [
      { ...row, concept: fields.upper, measurementGroup: row.object.scope },
      { ...row, concept: fields.lower, value: 0, measurementGroup: row.object.scope },
    ]);
    evidence.measurements.push(...elevations);
    files.set(evidencePath, JSON.stringify(evidence));
    const baseline = await replay(files, false, [item]);
    const updated = await replay(files, false, [{ ...item, libraryTool: { ...tool, id: toolId(recipe), recipe } }]);
    const comparison = compareModelCheckReports(baseline, updated);
    expect(comparison.changes).toEqual([]);
    expect(comparison.runs[0]).toMatchObject({ before: { tool: { id: tool.id } }, after: { tool: { id: toolId(recipe) } },
      changes: { plan: true, evidence: false, review: false } });
  });
  it('reports export observations and missing prerequisites without binding them as measurements', async () => {
    const files = offlineModel('baseline');
    for (const path of files.keys()) if (/\/space\.(csv|geojson)$/.test(path)) files.delete(path);
    const revision = JSON.parse(files.get('project_metadata.json')!).engineering_revision;
    const observation = (scope: string, table: string, id: string, modelFacts: object) =>
      ({ object: { scope, table, id }, revitUniqueId: `${scope}/${table}/${id}`, modelFacts, confirmed: true });
    const slab = observation('lv-1', 'structure_slab', 's-1', { nominalThicknessM: 0.12 });
    const sidecar = { version: 1, modelRevision: revision, measurements: [], applicability: [],
      roomExport: { status: 'disabled', hostRooms: 2, placedRooms: 2, csvRows: 0, footprints: 0, mepSpaces: 0, linkInstances: 1 },
      observations: [
      observation('global', 'level', 'lv-1', { exportedElevationM: 0, candidateUpperLevelId: 'lv-2' }),
      slab, observation('lv-2', 'structure_slab', 's-1', { nominalThicknessM: 0.09 }),
      observation('lv-1', 'door', 'd-1', { nominalWidthM: 0.9 }),
    ] };
    files.set(evidencePath, JSON.stringify(sidecar));
    const report = await replay(files);
    expect(report.evidenceInventory).toMatchObject({ status: 'loaded', confirmedMeasurements: 0,
      roomExport: { status: 'disabled', hostRooms: 2, footprints: 0 },
      observedByTable: { level: 1, structure_slab: 2, door: 1 } });
    expect(report.results.every(row => row.status === 'indeterminate')).toBe(true);
    const find = (id: string, scope?: string, objectId?: string) =>
      report.results.find(row => row.ruleId === id && row.object?.scope === scope && row.object?.id === objectId);
    expect(find('JT-01', 'global', 'lv-1')).toMatchObject({
      diagnosis: { blockers: ['confirm-level'], candidate: { value: 3, label: '候选标高差', relatedObject: { id: 'lv-2' } } },
    });
    expect(find('JG-03', 'lv-1', 's-1')?.diagnosis).toMatchObject({
      blockers: ['confirm-applicability', 'confirm-measurement'], candidate: { value: 0.12, label: '名义板厚' },
    });
    expect(find('JG-03', 'lv-2', 's-1')?.diagnosis?.candidate?.value).toBe(0.09);
    expect(find('JT-12', 'lv-1', 'd-1')?.diagnosis?.blockers).toEqual([
      'confirm-applicability', 'confirm-measurement', 'confirm-door-use',
    ]);
    for (const rule of ['JT-02', 'JT-03', 'JT-08'])
      expect(find(rule)).toMatchObject({ object: null, diagnosis: { blockers: ['missing-object'] } });
    expect(report.exportFeedback.find(row => row.ruleId === 'JT-12')?.blockers)
      .toContainEqual({ kind: 'confirm-door-use', count: 5 });

    sidecar.observations.push(slab);
    files.set(evidencePath, JSON.stringify(sidecar));
    expect((await replay(files)).results.find(row => row.ruleId === 'JG-03' && row.object?.scope === 'lv-1' &&
      row.object.id === 's-1')?.diagnosis?.candidate).toBeUndefined();
    sidecar.modelRevision = 'stale';
    files.set(evidencePath, JSON.stringify(sidecar));
    const stale = await replay(files);
    expect(stale.evidenceInventory.status).toBe('invalid');
    expect(stale.results.find(row => row.ruleId === 'JG-03')?.diagnosis).toEqual({ blockers: ['invalid-evidence'] });
  });
  it('denies determinate results for baseline and stale evidence without confirmations', async () => {
    const baseline = await replay(offlineModel('baseline'));
    const stale = await replay(offlineModel('stale'));
    for (const report of [baseline, stale]) {
      expect(report.pending).toHaveLength(0);
      expect(report.results).toHaveLength(30);
      expect(report.results.every(row => row.status === 'indeterminate')).toBe(true);
      expect(report.exportFeedback.map(item => item.ruleId)).toEqual(['JT-01', 'JT-02', 'JT-03', 'JG-03', 'JT-08', 'JT-12']);
    }
    expect(stale.results.some(row => 'reason' in row && /engineering_revision/.test(row.reason ?? ''))).toBe(true);
    expect(stale.modelVersion).not.toBe(baseline.modelVersion);
  });

  it('replays six original rule shapes with scoped evidence and exact threshold boundaries', async () => {
    const report = await replay(offlineModel('complete'), true);
    expect(report.pending).toHaveLength(0);
    expect(statuses(report, 'JT-01')).toEqual({
      'global/lv-1': 'pass', 'global/lv-2': 'fail', 'global/lv-3': 'not-applicable', 'global/lv-4': 'indeterminate',
    });
    expect(statuses(report, 'JT-02')).toMatchObject({ 'lv-1/r-1': 'pass', 'lv-1/r-2': 'fail', 'lv-2/r-1': 'not-applicable' });
    expect(statuses(report, 'JT-03')).toMatchObject({ 'lv-2/r-1': 'pass', 'lv-2/r-2': 'fail', 'lv-1/r-1': 'not-applicable' });
    expect(statuses(report, 'JG-03')).toEqual({ 'lv-1/s-1': 'pass', 'lv-2/s-1': 'fail', 'lv-1/s-2': 'not-applicable' });
    expect(statuses(report, 'JT-12')).toEqual({
      'lv-1/d-1': 'fail', 'lv-1/d-2': 'pass', 'lv-1/d-3': 'pass', 'lv-1/d-4': 'pass', 'lv-1/d-5': 'indeterminate',
    });
    expect(statuses(report, 'JT-08')).toMatchObject({
      'lv-2/r-1': 'fail', 'lv-2/r-2': 'pass', 'lv-2/r-3': 'pass', 'lv-2/r-4': 'pass', 'lv-1/r-1': 'not-applicable',
    });
    expect(report.results.find(row => row.ruleId === 'JT-08' && row.status === 'fail')).toMatchObject({
      object: { scope: 'lv-2', id: 'r-1' },
      overlap: { violations: [{ lowerObject: { scope: 'lv-1', id: 'r-1' }, evidence: { area: 1, modelVersion: report.modelVersion } }] },
    });
    expect(report.results.find(row => row.ruleId === 'JG-03' && row.status === 'pass')).toMatchObject({
      libraryToolId: 'pal.slab.cast-in-place-solid-structural-thickness.read@1',
      libraryInputs: [{ value: 100, unit: 'mm', source: '合成算例，经构造验证' }],
    });
  });

  it('keeps a nominal thickness, unconfirmed or duplicate measurement and a mismatched frame out of the result', async () => {
    const wrongConcept = await replay(offlineModel('wrong-concept'));
    expect(statuses(wrongConcept, 'JG-03')).toMatchObject({ 'lv-1/s-1': 'indeterminate', 'lv-2/s-1': 'indeterminate' });
    const files = offlineModel('complete');
    const data = JSON.parse(files.get(evidencePath)!);
    const firstSlab = data.measurements.find((fact: { object: { table: string } }) => fact.object.table === 'structure_slab');
    firstSlab.confirmed = false;
    data.doorUses.push({ ...data.doorUses[1], use: 'entrance' });
    data.spaceRelations.footprints[0].frame = 'other-frame';
    files.set(evidencePath, JSON.stringify(data));
    const report = await replay(files);
    expect(statuses(report, 'JG-03')['lv-1/s-1']).toBe('indeterminate');
    expect(statuses(report, 'JT-12')['lv-1/d-2']).toBe('indeterminate');
    expect(statuses(report, 'JT-08')['lv-2/r-2']).toBe('indeterminate');
    data.measurements.push({ ...firstSlab, confirmed: true });
    data.spaceRelations.levelPairs.length = 0;
    files.set(evidencePath, JSON.stringify(data));
    const duplicate = await replay(files);
    expect(duplicate.results.find(row => row.ruleId === 'JG-03' && row.object?.scope === 'lv-1' && row.object.id === 's-1'))
      .toMatchObject({ status: 'indeterminate', reason: expect.stringContaining('重复') });
    expect(statuses(duplicate, 'JT-08')['lv-2/r-1']).toBe('indeterminate');
  });

  it('checks the coordinate frame declared by the exported footprint', async () => {
    const files = offlineModel('complete');
    const path = 'lv-2/space.geojson';
    const geometry = JSON.parse(files.get(path)!);
    geometry.features[0].properties.frame = 'another-export-frame';
    files.set(path, JSON.stringify(geometry));
    const report = await replay(files);
    expect(report.results.find(row => row.ruleId === 'JT-08' && row.object?.scope === 'lv-2' && row.object.id === 'r-1'))
      .toMatchObject({ status: 'indeterminate', diagnosis: { blockers: ['input-conflict'] } });
  });

  it('verifies each door limit against its own quote and requires approved tools and rules for import', () => {
    const { input, proposals, tools } = offlineCompilationInput();
    const jt12 = input.find(item => item.id === 'JT-12')!;
    const proposal = proposals.find(item => item.id === 'JT-12')!;
    const validate = (candidate: object) =>
      validatePalResponse(JSON.stringify({ rules: [candidate] }), [jt12.clause!], tools)[0].plan;
    expect(validate({ ...proposal, thresholds: { ...proposal.thresholds, entrance: '0.800m' } }).kind).toBe('blocked');
    const plan = validate(proposal);
    expect(bindPalPlan(jt12, plan, []).doorWidthRule).toBeUndefined();
    const rule = bindPalPlan(jt12, plan, tools).doorWidthRule!;
    expect(rule.reviewed).toBe(false);
    expect(importJsonRules(JSON.stringify({ rules: [rule] }), tools)[0].doorWidthRule).toBeUndefined();
    expect(importJsonRules(JSON.stringify({ rules: [{ ...rule, reviewed: true }] }), tools)[0].doorWidthRule).toBeDefined();
  });

  it('does not replace a top-bottom measurement recipe with a direct reading', () => {
    const { input, tools } = offlineCompilationInput();
    const slab = input.find(item => item.id === 'JG-03')!;
    const candidate = { id: slab.id, kind: 'tool-draft', operator: '>=', threshold: '100mm', recipe: {
      concept: 'slab.cast-in-place-solid-structural-thickness', operation: 'difference',
      inputs: ['slab.structural-top-elevation', 'slab.structural-bottom-elevation'],
    } };
    const [{ plan }] = validatePalResponse(JSON.stringify({ rules: [candidate] }), [slab.clause!], tools);
    expect(plan).toMatchObject({ kind: 'tool-draft', recipe: { operation: 'difference' } });
    const registered = offlineRules().find(item => item.id === 'JG-03')!.plan!;
    const limited = { ...slab, clause: { ...slab.clause!, note: '悬挑板另有加严' } };
    const rule = bindPalPlan(limited, registered, tools).rule;
    expect(rule?.applicability).toContain('仅已确认适用此基本限值');
    expect(rule?.applicability).toContain('悬挑板另有加严');
  });

  it('rejects an overlap plan when the comparison direction in the original text is reversed', () => {
    const input = offlineCompilationInput().input.find(item => item.id === 'JT-08')!;
    const clause = { ...input.clause!, condition: '上层卫生间投影与下层卧室、起居室、厨房、餐厅没有重叠判FAIL' };
    const [{ plan }] = validatePalResponse(JSON.stringify({ rules: [{ id: clause.id, kind: 'space-projection-exclusion' }] }), [clause]);
    expect(plan.kind).toBe('blocked');
  });
});

const replayDirectory = process.env.BIMDOWN_PAL_REPLAY_DIR;
it.skipIf(!replayDirectory)('replays the actual directory without modifying the model', async () => {
  const root = resolve(replayDirectory!);
  const isWithinModel = (file: string) => {
    const fromRoot = relative(root, file);
    return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
  };
  const ds = {
    async fetchText(path: string) {
      const file = resolve(root, path);
      if (!isWithinModel(file)) throw new Error('Invalid relative model path');
      try { return await readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
  const { levels, raw } = await readCheckLevels(ds);
  expect(levels.length).toBeGreaterThan(0);
  const items = offlineRules();
  const report = await runModelCheck(ds, items, new Map(), raw);
  const testChoices = new Map(report.results.flatMap(row => {
    const upper = row.diagnosis?.candidate?.relatedObject;
    return row.object && row.ruleId === 'JT-01' && upper ? [[row.object.id, { mode: 'upper' as const, id: upper.id }]] : [];
  }));
  const simulated = await runModelCheck(ds, items.filter(item => item.id === 'JT-01'), testChoices, raw);
  expect(simulated.results.filter(row => 'evidence' in row)).toHaveLength(testChoices.size);
  const output = process.env.BIMDOWN_PAL_REPLAY_REPORT;
  if (output) {
    const file = resolve(output);
    if (isWithinModel(file)) throw new Error('Report must be outside the model directory');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ruleBasis: 'Synthetic benchmark rules and independent tool fixtures',
      report, simulatedLevelReview: { purpose: 'Execution test only, no actual reviewer confirmation', results: simulated.results },
    }, null, 2));
  }
});
