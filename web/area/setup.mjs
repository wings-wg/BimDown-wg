import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const editor = join(root, '.bimeditor-local');
const revision = 'f0c2e2386bce098484026ac093c3f30f7b95b3b3';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: editor, encoding: 'utf8' }).trim();
if (head !== revision) throw new Error(`Expected BimEditor revision ${revision}, found ${head}`);

const src = join(editor, 'app', 'src');
const area = join(src, 'area');
mkdirSync(join(area, 'core'), { recursive: true });
function copyChanged(from, to) {
  const next = readFileSync(from);
  if (existsSync(to) && readFileSync(to).equals(next)) return;
  writeFileSync(to, next);
}
for (const file of ['AreaWorkspace.tsx', 'AutomaticRooms.tsx', 'area.css'])
  copyChanged(join(root, 'web', 'area', file), join(area, file));
for (const file of ['autoRooms.ts', 'autoRooms.test.ts'])
  copyChanged(join(root, 'web', 'area', file), join(editor, 'editor', 'src', 'state', file));
copyChanged(join(root, 'web', 'area', 'folderLoading.test.ts'), join(editor, 'editor', 'src', 'dataSources', 'folderLoading.test.ts'));
for (const file of ['index.ts', 'factor.ts', 'project-input.ts', 'door-assignment.ts'])
  copyChanged(join(root, 'cli', 'src', 'area', file), join(area, 'core', file));

const demo = join(root, 'sample_data', 'area-example');
const roomGeometry = JSON.parse(readFileSync(join(demo, 'model', 'lv-1', 'space.geojson'), 'utf8'));
const feature = (id, type, coordinates) => ({ type: 'Feature', properties: { id }, geometry: { type, coordinates } });
for (const [id, x0, x1] of [['sp-102', 10, 13], ['sp-103', -3, 0]]) {
  roomGeometry.features.push(feature(id, 'Polygon', [[[x0, 0], [x1, 0], [x1, 8], [x0, 8], [x0, 0]]]));
}
const sampleWalls = [
  [[0, 0], [0, 8]], [[10, 0], [10, 8]], [[-3, 0], [-3, 8]], [[13, 0], [13, 8]],
  [[-3, 0], [0, 0]], [[0, 0], [10, 0]], [[10, 0], [13, 0]],
  [[-3, 8], [0, 8]], [[0, 8], [10, 8]], [[10, 8], [13, 8]],
];
const sampleEdge = (doorUuid, targetRoomUuid) => ({ doorUuid, targetRoomUuid, relation: 'door_adjacency' });
const sampleFiles = {
  'project_metadata.json': readFileSync(join(demo, 'model', 'project_metadata.json'), 'utf8'),
  'global/level.csv': 'id,name,elevation\nlv-1,示例一层,0\n',
  'lv-1/space.csv': 'id,name,number,x,y\nsp-101,客厅,101,5,4\nsp-102,卧室,102,11.5,4\nsp-103,公共走廊,103,-1.5,4\n',
  'lv-1/space.geojson': JSON.stringify(roomGeometry),
  'lv-1/wall.csv': 'id,thickness\n' + sampleWalls.map((_, i) => `w-${i + 1},0.2`).join('\n'),
  'lv-1/wall.geojson': JSON.stringify({ type: 'FeatureCollection',
    features: sampleWalls.map((line, i) => feature(`w-${i + 1}`, 'LineString', line)) }),
  'lv-1/door.csv': 'id,number,host_id,position,width,height\nd-1,入户门,w-1,4,0.9,2.1\nd-2,户内门,w-2,4,0.9,2.1\n',
  '_IdMap.csv': 'id,uuid,directory\nd-1,demo-entrance,lv-1\nd-2,demo-inner-door,lv-1\n' +
    'sp-101,demo-living,lv-1\nsp-102,demo-bedroom,lv-1\nsp-103,demo-hall,lv-1\n',
  'area_features.json': JSON.stringify({ version: 1, source: 'Synthetic demo', rooms: [
    { id: 'sp-101', uuid: 'demo-living', name: '客厅', phaseUuid: 'demo-phase',
      connections: [sampleEdge('demo-entrance', 'demo-hall'), sampleEdge('demo-inner-door', 'demo-bedroom')] },
    { id: 'sp-102', uuid: 'demo-bedroom', name: '卧室', phaseUuid: 'demo-phase',
      connections: [sampleEdge('demo-inner-door', 'demo-living')] },
    { id: 'sp-103', uuid: 'demo-hall', name: '公共走廊', phaseUuid: 'demo-phase', isCommon: true,
      connections: [sampleEdge('demo-entrance', 'demo-living')] },
  ] }),
  'project-config.json': readFileSync(join(demo, 'project-config.json'), 'utf8'),
};
const samplePath = join(area, 'sample.ts');
const sampleModule = `export const areaSample = new Map<string, string>(${JSON.stringify(Object.entries(sampleFiles))});\n`;
if (!existsSync(samplePath) || readFileSync(samplePath, 'utf8') !== sampleModule)
  writeFileSync(samplePath, sampleModule);

function edit(file, replacements) {
  const path = join(editor, file);
  const original = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  let content = original;
  for (const [before, after] of replacements) {
    if (after ? content.includes(after) : !content.includes(before)) continue;
    if (!content.includes(before)) throw new Error(`Cannot apply area integration to ${file}`);
    content = content.replace(before, after);
  }
  if (content !== original) writeFileSync(path, content);
}

edit('app/src/EditorView.tsx', [
  ["import { useCallback } from 'react';", "import { useCallback } from 'react';\nimport { AreaWorkspace } from './area/AreaWorkspace.tsx';"],
  ['  EditorShell,\n', ''],
  ['return <EditorShell />;', 'return <AreaWorkspace />;'],
  ['  useLiveProject(projectName);\n  return <AreaWorkspace />;', `  const status = useLiveProject(projectName);
  const { i18n } = useTranslation();
  if (status === 'ready') return <AreaWorkspace />;
  const zh = i18n.language === 'zh';
  return (
    <div className="flex h-full items-center justify-center px-6 text-sm text-[var(--text-secondary)]">
      {status === 'loading'
        ? <p role="status">{zh ? '正在读取项目楼层…' : 'Loading project floors…'}</p>
        : <p role="alert">{zh
          ? '无法读取项目楼层。请返回首页，重新打开含 global/level.csv 的项目目录或压缩包。'
          : 'Could not load the floors. Go back and reopen the project folder or archive containing global/level.csv.'}</p>}
    </div>
  );`],
]);
edit('app/src/App.tsx', [
  ["import { createLocalDataSource } from 'bimdown-editor';", "import { createLocalDataSource } from 'bimdown-editor';\nimport { areaSample } from './area/sample.ts';"],
  ["input.accept = '.zip';", "input.accept = '.zip,.bimdown';"],
  ["file.name.replace(/\\.zip$/i", "file.name.replace(/\\.(zip|bimdown)$/i"],
  ['  const handleBack = useCallback(() => {',
    "  const handleOpenAreaSample = useCallback(() => {\n    const mem = createMemoryDataSource(areaSample);\n    setState({ view: 'editor', ds: mem.dataSource, name: '面积测算示例', memoryHandle: mem });\n  }, []);\n\n  const handleBack = useCallback(() => {"],
  ['      onOpenSample={import.meta.env.DEV ? handleOpenSample : undefined}',
    '      onOpenSample={import.meta.env.DEV ? handleOpenSample : undefined}\n      onOpenAreaSample={handleOpenAreaSample}'],
]);
edit('app/src/LandingPage.tsx', [
  ['  onOpenSample?: () => void;', '  onOpenSample?: () => void;\n  onOpenAreaSample: () => void;'],
  ['onOpenUrl, onOpenSample }: LandingPageProps', 'onOpenUrl, onOpenSample, onOpenAreaSample }: LandingPageProps'],
  ['          {onOpenSample && (',
    `          <button type="button" onClick={onOpenAreaSample}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-border bg-[var(--card)] hover:bg-[var(--bg-hover)] transition-colors text-left">
            <FileBox size={20} className="text-[var(--color-accent)] shrink-0" />
            <span>{i18n.language === 'zh' ? '打开面积测算样例' : 'Open area allocation sample'}</span>
          </button>
          {onOpenSample && (`],
]);

// Keep imported attributes intact. Use the editor's existing display defaults
// when resolving hosted geometry from empty CSV dimensions.
edit('editor/src/model/parse.ts', [
  ["    const width = parseFloat(line.attrs.width ?? '0.9');",
    `    const importedWidth = parseFloat(line.attrs.width ?? '');
    const displayWidth = parseFloat(defaultAttrsForTable(line.tableName, '').width ?? '0.9');
    const width = Number.isFinite(importedWidth) && importedWidth > 0 ? importedWidth : displayWidth;
    if (!Number.isFinite(position) || !Number.isFinite(width) || width <= 0) continue;`],
]);

// Git for Windows can check a symlink out as a small file containing its target.
const hdr = join(editor, 'app', 'public', 'env.hdr');
const hdrStat = lstatSync(hdr);
if (hdrStat.isFile() && hdrStat.size < 128 &&
    readFileSync(hdr, 'utf8').trim() === '../../editor/public/env.hdr') {
  copyFileSync(join(editor, 'editor', 'public', 'env.hdr'), hdr);
}
edit('editor/src/three/SceneContent.tsx', [
  ['files="/env.hdr"', 'files="/env.hdr?bimdown-hdr=1"'],
]);
edit('editor/src/exports.ts', [
  ["import './elements/registerAll.ts';", "import './elements/registerAll.ts';\nexport { parseCsv } from './utils/loader.ts';"],
  ["export { parseCsv } from './utils/loader.ts';",
    "export { parseCsv } from './utils/loader.ts';\nexport { automaticRoomName, automaticRoomPatches, previewAutomaticRooms } from './state/autoRooms.ts';"],
]);
edit('editor/src/geometry/pickBoundary.ts', [
  ['\nfunction insidePoint(poly: Point[]): Point | null {', '\nexport function insidePoint(poly: Point[]): Point | null {'],
]);

edit('editor/src/dataSources/fileSystem.ts', [
  [`/** Recursively collect all files under a directory handle, returning relative paths → mtime. */
async function collectFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();`,
  `async function* walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<[string, FileSystemFileHandle]> {`],
  [`      const file = await (entry as FileSystemFileHandle).getFile();
      result.set(path, file.lastModified);
    } else if (entry.kind === 'directory') {
      const sub = await collectFiles(entry as FileSystemDirectoryHandle, path);
      for (const [k, v] of sub) result.set(k, v);
    }
  }
  return result;
}`, `      yield [path, entry as FileSystemFileHandle];
    } else if (entry.kind === 'directory') {
      yield* walkFiles(entry as FileSystemDirectoryHandle, path);
    }
  }
}

/** Read timestamps only for change detection. */
async function collectFiles(dir: FileSystemDirectoryHandle): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for await (const [path, handle] of walkFiles(dir, '')) {
    try {
      result.set(path, (await handle.getFile()).lastModified);
    } catch (err) {
      if ((err as DOMException)?.name !== 'NotFoundError') throw err;
    }
  }
  return result;
}`],
  [`    async listFiles(): Promise<string[]> {
      try {
        return [...(await collectFiles(dirHandle, '')).keys()];
      } catch {
        return [];
      }
    },`, `    async listFiles(): Promise<string[]> {
      const paths: string[] = [];
      for await (const [path] of walkFiles(dirHandle, '')) paths.push(path);
      return paths;
    },`],
  ["collectFiles(dirHandle, '').then", 'collectFiles(dirHandle).then'],
  ["await collectFiles(dirHandle, '')", 'await collectFiles(dirHandle)'],
]);

edit('editor/src/utils/loader.ts', [
  ["  const text = await fetchIfPresent('global/level.csv');",
    "  const text = await fetchIfPresent('global/level.csv');\n  if (text === null && manifest?.has('global/level.csv')) throw new Error('Could not read global/level.csv');"],
]);
edit('editor/src/hooks/useLiveProject.ts', [
  ["import { useEffect, useRef } from 'react';", "import { useEffect, useRef, useState } from 'react';"],
  ['export function useLiveProject(model: string): void {', "export function useLiveProject(model: string): 'loading' | 'ready' | 'error' {"],
  ['  const ds = useDataSource();', "  const ds = useDataSource();\n  const [load, setLoad] = useState<{ ds: typeof ds; model: string; status: 'ready' | 'error' }>();"],
  [`      const [project, grids] = await Promise.all([loadProject(ds), loadGrids(ds)]);
      if (active) dispatch({ type: 'SET_PROJECT', model, project, grids });`, `      try {
        const [project, grids] = await Promise.all([loadProject(ds), loadGrids(ds)]);
        if (!active) return;
        dispatch({ type: 'SET_PROJECT', model, project, grids });
        setLoad({ ds, model, status: 'ready' });
      } catch (error) {
        if (!active) return;
        console.error('BimDown project load failed:', error);
        setLoad({ ds, model, status: 'error' });
      }`],
  ['  }, [dispatch, ds, model]);\n}', "  }, [dispatch, ds, model]);\n\n  return load?.ds === ds && load.model === model ? load.status : 'loading';\n}"],
]);

// Keep the live project and its shared editor context on the same module revision.
edit('app/vite.config.ts', [
  ["import { defineConfig } from 'vite'", "import { defineConfig, normalizePath } from 'vite'"],
  ["const sampleDataDir = path.resolve(__dirname, '..', 'sample_data')",
    "const sampleDataDir = path.resolve(__dirname, '..', 'sample_data')\nconst editorSrcDir = path.resolve(__dirname, '../editor/src')"],
  ["      name: 'watch-editor-src',", `      name: 'watch-editor-src',
      handleHotUpdate({ file, server }) {
        if (!normalizePath(file).startsWith(normalizePath(editorSrcDir) + '/')) return;
        server.ws.send({ type: 'full-reload' });
        return [];
      },`],
  ["server.watcher.add(path.resolve(__dirname, '../editor/src'));", 'server.watcher.add(editorSrcDir);'],
]);
