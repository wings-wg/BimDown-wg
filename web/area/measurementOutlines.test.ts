import { describe, expect, it, vi } from 'vitest';
import type { LineElement, PointElement } from '../model/elements.ts';
import { createHarness } from '../test/authorHarness.ts';
import { fc, memoryDataSource } from '../test/memoryDataSource.ts';
import { persistDocument } from '../utils/persist.ts';
import { generateMeasurementOutlines } from './measurementOutlines.ts';

const path = 'lv-1/space.geojson';
const level = { id: 'lv-1', name: 'F1', number: '1', elevation: 0 };

function room(id: string, x: number, y: number): PointElement {
  return { id, tableName: 'space', discipline: 'architecture', geometry: 'point', position: { x, y },
    width: 0.3, height: 0.3, attrs: { id, x: String(x), y: String(y), name: id } };
}

function wall(id: string, x1: number, y1: number, x2: number, y2: number): LineElement {
  return { id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, strokeWidth: 0.2, attrs: { id, thickness: '0.2' } };
}

function square(prefix: string, x: number, y: number, size = 4) {
  return [
    wall(`${prefix}-1`, x, y, x + size, y), wall(`${prefix}-2`, x + size, y, x + size, y + size),
    wall(`${prefix}-3`, x + size, y + size, x, y + size), wall(`${prefix}-4`, x, y + size, x, y),
  ];
}

describe('measurement outlines', () => {
  it('writes a wall-centre polygon and uses the existing save queue to keep room deletions consistent', async () => {
    const h = createHarness([level]);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [...square('w', 0, 0),
      wall('w-stub', 0, 2, 2, 2), room('sp-1', 2, 3)] });
    const ds = memoryDataSource({});
    const generated = await generateMeasurementOutlines(h.state, ds, 'level');
    expect(generated).toEqual({ generated: 1, preserved: 0, issues: [] });
    const [feature] = JSON.parse(ds.files[path]).features;
    const [ring] = feature.geometry.coordinates as [number, number][][];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring).not.toContainEqual([2, 2]);
    const area = Math.abs(ring.slice(0, -1).reduce((sum, [x, y], i) =>
      sum + x * ring[i + 1][1] - y * ring[i + 1][0], 0) / 2);
    expect(area).toBe(16);
    expect(feature.properties.net_area).toBeCloseTo(14.44);

    const repeated = generateMeasurementOutlines(h.state, ds, 'level');
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['sp-1'] });
    await Promise.all([repeated, persistDocument(h.state.document!, ds, new Set(['architecture/space']))]);
    expect(JSON.parse(ds.files[path]).features).toEqual([]);
  });

  it('preserves stored polygons with holes and fills only the missing rooms', async () => {
    const h = createHarness([level]);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [...square('w-a', 0, 0), ...square('w-b', 5, 0),
      room('sp-1', 2, 2), room('sp-2', 7, 2)] });
    const reviewed = { type: 'Feature', properties: { id: 'sp-1', net_area: 1 }, geometry: { type: 'Polygon',
      coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]] } };
    const ds = memoryDataSource({ [path]: fc([reviewed]) });
    expect(await generateMeasurementOutlines(h.state, ds, 'level')).toEqual({ generated: 1, preserved: 1, issues: [] });
    expect(JSON.parse(ds.files[path]).features[0]).toEqual(reviewed);
    const original = ds.files[path];
    ds.saveFile = vi.fn(ds.saveFile);
    expect((await generateMeasurementOutlines(h.state, ds, 'level')).preserved).toBe(2);
    expect(ds.saveFile).not.toHaveBeenCalled();
    expect(ds.files[path]).toBe(original);
  });

  it('reports missing, duplicated and nested boundaries without writing unsafe polygons', async () => {
    const h = createHarness([level]);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [
      ...square('w-duplicate', 0, 0), ...square('w-nested', 10, 0, 8), ...square('w-inner', 12, 2),
      room('sp-1', 1, 1), room('sp-2', 3, 3), room('sp-3', 6, 6), room('sp-4', 14, 4),
    ] });
    const ds = memoryDataSource({});
    const result = await generateMeasurementOutlines(h.state, ds, 'level');
    expect(result.issues.map(issue => [issue.room?.elementId, issue.reason])).toEqual([
      ['sp-1', expect.stringContaining('多个房间')], ['sp-2', expect.stringContaining('多个房间')],
      ['sp-3', expect.stringContaining('未落在闭合')], ['sp-4', expect.stringContaining('嵌套')],
    ]);
    expect(ds.files[path]).toBeUndefined();
  });

  it('scopes short room IDs by floor and blocks stale or failed writes independently', async () => {
    const second = { ...level, id: 'lv-2', number: '2', name: 'F2', elevation: 3 };
    const h = createHarness([level, second]);
    const firstElements = [...square('w', 0, 0), room('sp-1', 1, 1)];
    const secondElements = [...square('w', 10, 0), room('sp-1', 11, 1)];
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: firstElements });
    h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Synthetic second floor',
      patches: new Map([[second.id, new Map(secondElements.map(el => [el.id, el]))]]) });
    const secondPath = 'lv-2/space.geojson';
    const ds = memoryDataSource({ [secondPath]: 'bad GeoJSON' });
    const result = await generateMeasurementOutlines(h.state, ds, 'project');
    expect(result.generated).toBe(1);
    expect(result.issues.map(issue => issue.level)).toEqual(['lv-2']);
    expect(ds.files[secondPath]).toBe('bad GeoJSON');
    expect(JSON.parse(ds.files[path]).features[0].properties.id).toBe('sp-1');

    const fresh = memoryDataSource({});
    expect((await generateMeasurementOutlines(h.state, fresh, 'project', () => false)).generated).toBe(0);
    expect(fresh.files).toEqual({});
    expect((await generateMeasurementOutlines(h.state, fresh, 'project')).generated).toBe(2);
    expect(JSON.parse(fresh.files[secondPath]).features[0].geometry.coordinates[0]).toContainEqual([10, 0]);
  });
});
