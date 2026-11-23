import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createMemoryDataSource, loadProjectFromZip } from 'bimdown-editor/data-sources';
import type { ProjectAreaConfig } from './core/project-input.js';
import { assignSelectedRooms } from './manual-room-assignment.js';
import { saveRoomAllocation } from './common-room-allocation.js';
import { removeAreaUnit } from './area-deletion.js';
import { AREA_CONFIG_PATH, getProjectAreaStore, parseProjectAreaConfig } from './project-area-storage.js';

const empty: ProjectAreaConfig = {
  version: 1, confirmed: false, ruleSource: '', nodes: [], groups: [], selections: [],
};
const room = (id: string, level = 'lv-1') => ({ level, elementId: id, name: id });
const firstUnit = assignSelectedRooms(empty, [room('sp-1'), room('sp-1', 'lv-2')], '101', false);
const twoUnits = assignSelectedRooms(firstUnit, [room('sp-2')], '102', false);
const withAllocation = saveRoomAllocation(twoUnits, room('sp-3'), {
  method: 'equal', factor: 0.5, recipients: ['101', '102'],
  boundarySource: 'Synthetic measure', allocationSource: 'Synthetic agreement',
});

describe('project area storage', () => {
  it('persists consecutive edits in order, restores all configuration on reopen and keeps projects independent', async () => {
    const files = new Map<string, string>();
    const openFolder = () => getProjectAreaStore({
      fetchText: async path => files.get(path) ?? null,
      saveFile: async (path, text) => { files.set(path, text); },
    });
    const store = openFolder();
    expect(await store.load()).toBeNull();
    expect(files.size).toBe(0);
    const firstSave = store.save(JSON.stringify(firstUnit));
    const nextSave = store.save(JSON.stringify(withAllocation));
    await store.flush();
    await Promise.all([firstSave, nextSave]);

    const reopened = openFolder();
    expect(parseProjectAreaConfig((await reopened.load())!)).toEqual(withAllocation);
    const afterDelete = removeAreaUnit(withAllocation, '102');
    await reopened.save(JSON.stringify(afterDelete));
    expect(parseProjectAreaConfig((await openFolder().load())!)).toEqual(afterDelete);
    expect(await getProjectAreaStore(createMemoryDataSource().dataSource).load()).toBeNull();
  });

  it('restores assignments and shared rules from the updated project ZIP', async () => {
    const project = createMemoryDataSource(new Map([['global/level.csv', 'id\nlv-1']]));
    const store = getProjectAreaStore(project.dataSource);
    await store.load();
    const save = store.save(JSON.stringify(withAllocation));
    await store.flush();
    await save;
    const zip = new JSZip();
    for (const [path, content] of project.getFiles()) zip.file(path, content);
    const reopened = createMemoryDataSource(await loadProjectFromZip(await zip.generateAsync({ type: 'blob' })));
    expect(await reopened.dataSource.fetchText('global/level.csv')).toBe('id\nlv-1');
    expect(parseProjectAreaConfig((await getProjectAreaStore(reopened.dataSource).load())!)).toEqual(withAllocation);
  });

  it('reports failed writes, blocks stale exports and permits a successful retry', async () => {
    const project = createMemoryDataSource();
    const source = {
      ...project.dataSource,
      saveFile: vi.fn(project.dataSource.saveFile).mockRejectedValueOnce(new Error('No write permission')),
    };
    const store = getProjectAreaStore(source);
    await store.load();
    await expect(store.save(JSON.stringify(firstUnit))).rejects.toThrow('No write permission');
    await expect(store.flush()).rejects.toThrow('No write permission');
    await store.save(JSON.stringify(withAllocation));
    await expect(store.load()).resolves.toBe(JSON.stringify(withAllocation));
  });

  it('preserves an external edit until the configuration is explicitly read again', async () => {
    const { dataSource } = createMemoryDataSource();
    const store = getProjectAreaStore(dataSource);
    await store.load();
    await store.save(JSON.stringify(firstUnit));
    const external = JSON.stringify({ ...firstUnit, ruleSource: 'External review' });
    await dataSource.saveFile(AREA_CONFIG_PATH, external);
    await expect(store.save(JSON.stringify(withAllocation))).rejects.toThrow('已被其他操作修改');
    expect(await dataSource.fetchText(AREA_CONFIG_PATH)).toBe(external);
    expect(await store.load()).toBe(external);
    await store.save(JSON.stringify(withAllocation));
  });

  it('protects unreadable configuration files and rejects malformed imports before writing', async () => {
    const saveFile = vi.fn(async () => {});
    const store = getProjectAreaStore({
      fetchText: async () => null, listFiles: async () => [AREA_CONFIG_PATH], saveFile,
    });
    await expect(store.load()).rejects.toThrow('已存在，但无法读取');
    await expect(store.save(JSON.stringify(firstUnit))).rejects.toThrow('请先读取');
    expect(() => store.save('{}')).toThrow('版本 1');
    expect(saveFile).not.toHaveBeenCalled();
  });
});
