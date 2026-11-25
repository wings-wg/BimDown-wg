import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { calculateProjectAreas, type ProjectAreaConfig } from './project.js';
import { calculateProjectAreasFromText } from './project-input.js';
const config = (): ProjectAreaConfig => ({ version: 1, confirmed: true, ruleSource: 'reviewed',
  nodes: [{ id: 'u', type: 'unit', building: 'b' }, { id: 'p', type: 'pool', building: 'b' }],
  selections: [{ id: 'a', owner: 'u', level: 'lv-1', table: 'space', elementId: 'sp1', kind: 'usable', factor: 'auto', source: 'approved outline',
    features: { type: 'room', permanent: true, height: 2.2, variableHeight: false, publicPassage: false } }],
  parts: [{ id: 'common', owner: 'p', kind: 'common', area: 20, factor: 1, source: 'reviewed' }],
  groups: [{ id: 'g', pool: 'p', method: 'area', recipients: [{ id: 'u' }], source: 'reviewed' }] });
function files() { return {
  'project_metadata.json': JSON.stringify({ format_version: '2', units: 'mm' }),
  'lv-1/space.geojson': JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { id: 'sp1' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[10000,0],[10000,10000],[0,10000],[0,0]]] } }] }),
  'area_features.json': JSON.stringify({ version: 1, rooms: [{ id: 'sp1', covered: true, enclosed: true }] }),
}; }
describe('BIMDown area adapter', () => {
  it('matches the browser text adapter with the filesystem report for the demo', () => {
    const demo = new URL('../../../sample_data/area-example/', import.meta.url);
    const config = JSON.parse(readFileSync(new URL('project-config.json', demo), 'utf8')) as ProjectAreaConfig;
    const model = new URL('model/', demo);
    const files = new Map(['project_metadata.json', 'lv-1/space.geojson'].map(path =>
      [path, readFileSync(new URL(path, model), 'utf8')]));
    const report = calculateProjectAreasFromText(path => files.get(path), config);
    expect(report.units[0]).toMatchObject({ internalArea: 80, sharedArea: 20, totalArea: 100 });
    expect(report).toEqual(calculateProjectAreas(fileURLToPath(model), config));
  });

  it('calculates identical directory and archive results, converts units and consumes confirmed evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'area-project-'));
    try {
      mkdirSync(join(dir, 'lv-1'));
      const entries = files();
      for (const [path, value] of Object.entries(entries)) writeFileSync(join(dir, path), value);
      const archive = join(dir, 'project.bimdown');
      writeFileSync(archive, zipSync(Object.fromEntries(Object.entries(entries).map(([k,v]) => [k,strToU8(v)]))));
      const result = calculateProjectAreas(dir, config());
      expect(result.units[0].totalArea).toBe(120);
      expect(calculateProjectAreas(archive, config()).units).toEqual(result.units);
      const duplicate = config(); duplicate.selections.push(duplicate.selections[0]);
      expect(() => calculateProjectAreas(dir, duplicate)).toThrow(/Duplicate/);
      const unsafe = config(); unsafe.selections[0].level = '..';
      expect(() => calculateProjectAreas(dir, unsafe)).toThrow(/Unsafe/);
      writeFileSync(join(dir, 'area_features.json'), JSON.stringify({rooms:[]}));
      expect(() => calculateProjectAreas(dir, config())).toThrow(/Indeterminate/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds Revit room evidence by level when both levels reuse a short ID', () => {
    const input = config();
    input.selections.push({ ...input.selections[0], id: 'upper', level: 'lv-2' });
    const entries = new Map(Object.entries(files()));
    entries.set('lv-2/space.geojson', entries.get('lv-1/space.geojson')!);
    entries.set('area_features.json', JSON.stringify({ rooms: [
      { id: 'sp1', scope: 'lv-2', covered: true, enclosed: true, uuid: 'upper-room' },
      { id: 'sp1', scope: 'lv-1', covered: true, enclosed: true, uuid: 'lower-room' },
    ] }));
    const report = calculateProjectAreasFromText(path => entries.get(path), input);
    expect(report.modelSources.map(source => source.featureEvidence.uuid)).toEqual(['lower-room', 'upper-room']);
    entries.set('area_features.json', JSON.stringify({ rooms: [
      { id: 'sp1', scope: 'lv-2', covered: true, enclosed: true },
    ] }));
    expect(() => calculateProjectAreasFromText(path => entries.get(path), input)).toThrow(/Indeterminate/);
  });
});
