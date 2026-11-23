import { describe, expect, it } from 'vitest';
import type { PointElement } from '../model/elements.ts';
import { createHarness } from '../test/authorHarness.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';
import { parseCsv } from './loader.ts';
import { persistDocument } from './persist.ts';

function room(id: string): PointElement {
  return { id, tableName: 'space', discipline: 'architecture', geometry: 'point',
    position: { x: 2, y: 2 }, width: 0.3, height: 0.3, attrs: { id, x: '2', y: '2' } };
}

describe('persisting a room deletion', () => {
  it('prunes only the deleted outlines and keeps the native undo and save order', async () => {
    const h = createHarness();
    const outline = 'lv-1/space.geojson';
    const csv = 'lv-1/space.csv';
    const features = ['sp-1', 'sp-2'].map(id => ({
      type: 'Feature', properties: { id },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    }));
    const ds = memoryDataSource({ [outline]: JSON.stringify({ type: 'FeatureCollection', features }) });
    const spaceLayer = new Set(['architecture/space']);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [room('sp-1'), room('sp-2')] });
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['sp-1'] });
    await persistDocument(h.state.document!, ds, spaceLayer);
    expect(parseCsv(ds.files[csv]).map(row => row.id)).toEqual(['sp-2']);
    expect(JSON.parse(ds.files[outline]).features).toEqual([features[1]]);

    h.dispatch({ type: 'UNDO' });
    const saveUndo = persistDocument(h.state.document!, ds, spaceLayer);
    h.dispatch({ type: 'REDO' });
    const saveRedo = persistDocument(h.state.document!, ds, spaceLayer);
    await Promise.all([saveUndo, saveRedo]);
    expect(parseCsv(ds.files[csv]).map(row => row.id)).toEqual(['sp-2']);
    expect(JSON.parse(ds.files[outline]).features).toEqual([features[1]]);
  });
});
