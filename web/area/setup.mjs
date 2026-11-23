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
for (const file of ['AreaWorkspace.tsx', 'AutomaticRooms.tsx', 'UnitRoomList.tsx', 'CommonRoomAllocations.tsx',
  'common-room-allocation.ts', 'common-room-allocation.test.ts',
  'ManualRoomAssignment.tsx', 'manual-room-assignment.ts', 'manual-room-assignment.test.ts',
  'area-deletion.ts', 'area-deletion.test.ts', 'project-area-storage.ts', 'project-area-storage.test.ts', 'area.css',
  'ModelQuestionPanel.tsx', 'ModelQuestionSettings.tsx', 'model-qa-evidence.ts', 'model-qa-evidence.test.ts',
  'model-qa-types.ts', 'model-qa.css'])
  copyChanged(join(root, 'web', 'area', file), join(area, file));
for (const file of ['autoRooms.ts', 'autoRooms.test.ts', 'planDoorAssignment.ts', 'planDoorAssignment.test.ts',
  'unitRoomView.ts', 'unitRoomView.test.ts', 'measurementOutlines.ts', 'measurementOutlines.test.ts', 'modelQaGeometry.ts'])
  copyChanged(join(root, 'web', 'area', file), join(editor, 'editor', 'src', 'state', file));
copyChanged(join(root, 'web', 'area', 'folderLoading.test.ts'), join(editor, 'editor', 'src', 'dataSources', 'folderLoading.test.ts'));
for (const file of ['model-qa-server.ts', 'model-qa-server.test.ts'])
  copyChanged(join(root, 'web', 'area', file), join(editor, 'app', file));
for (const file of ['pruneRoomOutlines.ts', 'pruneRoomOutlines.test.ts'])
  copyChanged(join(root, 'web', 'area', file), join(editor, 'editor', 'src', 'utils', file));
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
  ["import { useTranslation } from 'react-i18next';", "import { useTranslation } from 'react-i18next';\nimport { AreaConfigInArchive } from './area/AreaWorkspace.tsx';\nimport { getProjectAreaStore } from './area/project-area-storage.js';"],
  ['  const handleDownloadZip = useCallback(async () => {\n    if (memoryHandle) {\n      await downloadProjectAsZip(memoryHandle.getFiles(), projectName);\n    }\n  }, [memoryHandle, projectName]);', `  const areaStore = getProjectAreaStore(ds);
  const zh = i18n.language === 'zh';
  const saveError = zh
    ? '无法保存项目。请在「面积测算与分摊」中查看保存状态，或下载配置备份。'
    : 'Could not save the project. Check the area panel for details or download a configuration backup.';

  const handleDownloadZip = useCallback(async () => {
    if (!memoryHandle) return;
    try {
      await areaStore.flush();
      await downloadProjectAsZip(memoryHandle.getFiles(), projectName);
    } catch {
      window.alert(saveError);
    }
  }, [areaStore, memoryHandle, projectName, saveError]);

  const handleBack = useCallback(async () => {
    try {
      await areaStore.flush();
    } catch {
      if (!window.confirm(zh ? '面积配置尚未保存，确定返回首页？' : 'The area configuration is unsaved. Return to the home page?')) return;
    }
    onBack();
  }, [areaStore, onBack, zh]);`],
  ['      const handle = await pickDirectory();\n      if (memoryHandle)', '      const handle = await pickDirectory();\n      await areaStore.flush();\n      if (memoryHandle)'],
  ['    } catch {\n      // User cancelled picker\n    }\n  }, [memoryHandle, onDataSourceChange]);', `    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) window.alert(saveError);
    }
  }, [areaStore, memoryHandle, onDataSourceChange, saveError]);`],
  ['            <EditorInner projectName={projectName} />', `            <AreaConfigInArchive.Provider value={Boolean(memoryHandle)}>
              <EditorInner projectName={projectName} />
            </AreaConfigInArchive.Provider>`],
  ['          onClick={onBack}', '          onClick={handleBack}'],
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
  ["{t('landing.privacy', 'This editor runs entirely in your browser. No data is uploaded.')}",
    "{i18n.language === 'zh' ? '模型在浏览器本地打开。配置语言模型后，提问会发送所需证据。' : 'Open models locally. When a language model is configured, questions send matching evidence.'}"],
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
  [` * far enough back that every corner is in view. Runs once per opened project
 * (an empty project is framed as soon as it gets content, e.g. the AI's first
 * build) and on the toolbar's zoom-to-fit (`, ` * far enough back that every corner is in view. Refits when the visible floors
 * change and on the toolbar's zoom-to-fit (`],
  [`  useEffect(() => {
    if (fittedFor.current !== modelName && fit()) fittedFor.current = modelName;
  }, [fit, modelName]);`, `  const floorScope = JSON.stringify([modelName, floor3DMode, floor3DMode === 'all' ? null : currentLevel]);
  useEffect(() => {
    if (fittedFor.current !== floorScope && fit()) fittedFor.current = floorScope;
  }, [fit, floorScope]);`],
  [`    if (enabled && bounds) {
      const planes = sectionBoxPlanes(bounds).map(() => new Plane());`, `    const floorPlanes = zRange ? [
      new Plane(new Vector3(0, 1, 0), -zRange[0]),
      new Plane(new Vector3(0, -1, 0), zRange[1]),
    ] : [];

    if (enabled && bounds) {
      const planes = sectionBoxPlanes(bounds).map(() => new Plane());`],
  ['      gl.clippingPlanes = planes;', '      gl.clippingPlanes = [...planes, ...floorPlanes];'],
  [`    if (!zRange) { gl.clippingPlanes = []; return; }
    gl.clippingPlanes = [
      new Plane(new Vector3(0, 1, 0), -zRange[0]),
      new Plane(new Vector3(0, -1, 0), zRange[1]),
    ];`, '    gl.clippingPlanes = floorPlanes;'],
]);
edit('editor/src/three/FloorGroup.tsx', [
  ['    if (doc && currentLevel) levelIds.add(currentLevel);',
    '    if (doc?.levelId === currentLevel) levelIds.add(currentLevel);'],
  ['      if (levelId === currentLevel && doc) {',
    '      if (levelId === currentLevel && doc?.levelId === currentLevel) {'],
  ['  const liveElements = liveDoc?.elements;',
    '  const liveElements = liveDoc?.levelId === currentLevel ? liveDoc.elements : undefined;'],
]);

edit('editor/src/i18n/zh.json', [
  ['  "levels.copySelectionHere":', '  "levels.showOnlyThisFloor": "仅显示该层",\n  "levels.copySelectionHere":'],
]);
edit('editor/src/i18n/en.json', [
  ['  "levels.copySelectionHere":', '  "levels.showOnlyThisFloor": "Show only this floor",\n  "levels.copySelectionHere":'],
]);
edit('editor/src/components/LeftPanel.tsx', [
  ['  x, y, onRename, onDuplicate, onCopyHere, onDelete, onClose,',
    '  x, y, editable, onShowOnly, onShowAll, onRename, onDuplicate, onCopyHere, onDelete, onClose,'],
  ['  x: number; y: number;\n  onRename:',
    '  x: number; y: number;\n  editable: boolean;\n  onShowOnly: () => void;\n  onShowAll?: () => void;\n  onRename:'],
  [`  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [onClose]);`, `  const ref = useRef<HTMLDivElement>(null);
  const itemClass = "flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] hover:bg-accent";

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handle);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', handle);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);`],
  [`      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
        onClick={() => { onRename(); onClose(); }}
      >
        {t('levels.edit')}…
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
        data-testid="level-duplicate"
        onClick={() => { onDuplicate(); onClose(); }}
      >
        {t('levels.duplicate')}…
      </button>
      {onCopyHere && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
          data-testid="level-copy-here"
          onClick={() => { onCopyHere(); onClose(); }}
        >
          {t('levels.copySelectionHere')}
        </button>
      )}
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[11px] text-red-400 hover:bg-accent"
        onClick={() => { onDelete(); onClose(); }}
      >
        {t('panel.delete')}
      </button>`, `      <button type="button" className={cn(itemClass, 'text-foreground')} onClick={() => { onShowOnly(); onClose(); }}>
        {t('levels.showOnlyThisFloor')}
      </button>
      {onShowAll && (
        <button type="button" className={cn(itemClass, 'text-foreground')} onClick={() => { onShowAll(); onClose(); }}>
          {t('view.floor.allTitle')}
        </button>
      )}
      {editable && (
        <div className="mt-1 border-t border-border pt-1">
          <button type="button" className={cn(itemClass, 'text-foreground')} onClick={() => { onRename(); onClose(); }}>
            {t('levels.edit')}…
          </button>
          <button type="button" className={cn(itemClass, 'text-foreground')} data-testid="level-duplicate"
            onClick={() => { onDuplicate(); onClose(); }}>
            {t('levels.duplicate')}…
          </button>
          {onCopyHere && (
            <button type="button" className={cn(itemClass, 'text-foreground')} data-testid="level-copy-here"
              onClick={() => { onCopyHere(); onClose(); }}>
              {t('levels.copySelectionHere')}
            </button>
          )}
          <button type="button" className={cn(itemClass, 'text-red-400')} onClick={() => { onDelete(); onClose(); }}>
            {t('panel.delete')}
          </button>
        </div>
      )}`],
  ['  const { activeDiscipline, selectedIds, readonly, project } = editorState;',
    '  const { activeDiscipline, selectedIds, readonly, project, viewMode, floor3DMode } = editorState;'],
  ['              onClick={() => dispatch({ type: \'SET_LEVEL\', levelId: level.id })}',
    `              aria-current={currentLevel === level.id ? 'true' : undefined}
              onClick={() => {
                if (viewMode === '2d') dispatch({ type: 'SET_FLOOR_3D_MODE', mode: 'current' });
                dispatch({ type: 'SET_LEVEL', levelId: level.id });
              }}`],
  ['                if (!readonly) setContextMenu({ x: e.clientX, y: e.clientY, level });',
    '                setContextMenu({ x: e.clientX, y: e.clientY, level });'],
  ['          y={contextMenu.y}\n          onRename=', `          y={contextMenu.y}
          editable={!readonly}
          onShowOnly={() => {
            dispatch({ type: 'SET_FLOOR_3D_MODE', mode: 'current' });
            if (contextMenu.level.id !== currentLevel) dispatch({ type: 'SET_LEVEL', levelId: contextMenu.level.id });
            dispatch({ type: 'SET_VIEW_MODE', mode: '3d' });
          }}
          onShowAll={floor3DMode === 'all' ? undefined : () => {
            dispatch({ type: 'SET_FLOOR_3D_MODE', mode: 'all' });
            dispatch({ type: 'SET_VIEW_MODE', mode: '3d' });
          }}
          onRename=`],
]);
edit('editor/src/exports.ts', [
  ["import './elements/registerAll.ts';", "import './elements/registerAll.ts';\nexport { parseCsv } from './utils/loader.ts';"],
  ["export { parseCsv } from './utils/loader.ts';",
    "export { parseCsv } from './utils/loader.ts';\nexport { automaticRoomName, automaticRoomPatches, previewAutomaticRooms } from './state/autoRooms.ts';"],
  ["export { automaticRoomName, automaticRoomPatches, previewAutomaticRooms } from './state/autoRooms.ts';",
    "export { automaticRoomName, automaticRoomPatches, previewAutomaticRooms } from './state/autoRooms.ts';\nexport { previewPlanDoorAssignment } from './state/planDoorAssignment.ts';"],
  ["export { previewPlanDoorAssignment } from './state/planDoorAssignment.ts';",
    "export { previewPlanDoorAssignment } from './state/planDoorAssignment.ts';\nexport { unitRoomView } from './state/unitRoomView.ts';\nexport { ZOOM_TO_EVENT } from './components/SchedulePanel.tsx';"],
  ["export { ZOOM_TO_EVENT } from './components/SchedulePanel.tsx';",
    "export { ZOOM_TO_EVENT } from './components/SchedulePanel.tsx';\nexport { generateMeasurementOutlines } from './state/measurementOutlines.ts';"],
  ["export { generateMeasurementOutlines } from './state/measurementOutlines.ts';",
    "export { generateMeasurementOutlines } from './state/measurementOutlines.ts';\nexport { describeRoomBoundaries } from './state/modelQaGeometry.ts';"],
]);
edit('app/vite.config.ts', [
  ["import fs from 'fs'", "import fs from 'fs'\nimport { modelQaPlugin } from './model-qa-server.ts'"],
  ['  plugins: [', '  plugins: [\n    modelQaPlugin(),'],
  ["    exclude: ['bimdown-editor'],", `    exclude: ['bimdown-editor'],
    // Avoid a dev-page reload when the lazy 3D canvas first discovers its dependencies.
    include: ['@react-three/drei', '@react-three/fiber', '@react-three/postprocessing', 'three-mesh-bvh', 'three-stdlib'],`],
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
edit('editor/src/utils/persist.ts', [
  ["import type { DataSource } from './dataSource.ts';",
    "import type { DataSource } from './dataSource.ts';\nimport { persistRoomLayer } from './pruneRoomOutlines.ts';"],
  ['    saves.push(write(csvPath, csvContent));', `    if (tableName === 'space') {
      saves.push(persistRoomLayer(ds, levelId, groupElements.map(el => el.id), () => write(csvPath, csvContent)));
    } else {
      saves.push(write(csvPath, csvContent));
    }`],
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
