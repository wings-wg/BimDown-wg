import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
for (const file of ['AreaWorkspace.tsx', 'area.css'])
  copyFileSync(join(root, 'web', 'area', file), join(area, file));
for (const file of ['index.ts', 'factor.ts', 'project-input.ts'])
  copyFileSync(join(root, 'cli', 'src', 'area', file), join(area, 'core', file));

const demo = join(root, 'sample_data', 'area-example');
const sampleFiles = {
  'project_metadata.json': readFileSync(join(demo, 'model', 'project_metadata.json'), 'utf8'),
  'global/level.csv': 'id,name,elevation\nlv-1,示例一层,0\n',
  'lv-1/space.csv': 'id,name,number\nsp-101,示例房间,101\n',
  'lv-1/space.geojson': readFileSync(join(demo, 'model', 'lv-1', 'space.geojson'), 'utf8'),
  'project-config.json': readFileSync(join(demo, 'project-config.json'), 'utf8'),
};
writeFileSync(join(area, 'sample.ts'), `export const areaSample = new Map<string, string>(${JSON.stringify(Object.entries(sampleFiles))});\n`);

function edit(file, replacements) {
  const path = join(src, file);
  let content = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  for (const [before, after] of replacements) {
    if (after ? content.includes(after) : !content.includes(before)) continue;
    if (!content.includes(before)) throw new Error(`Cannot apply area integration to ${file}`);
    content = content.replace(before, after);
  }
  writeFileSync(path, content);
}

edit('EditorView.tsx', [
  ["import { useCallback } from 'react';", "import { useCallback } from 'react';\nimport { AreaWorkspace } from './area/AreaWorkspace.tsx';"],
  ['  EditorShell,\n', ''],
  ['return <EditorShell />;', 'return <AreaWorkspace />;'],
]);
edit('App.tsx', [
  ["import { createLocalDataSource } from 'bimdown-editor';", "import { createLocalDataSource } from 'bimdown-editor';\nimport { areaSample } from './area/sample.ts';"],
  ["input.accept = '.zip';", "input.accept = '.zip,.bimdown';"],
  ["file.name.replace(/\\.zip$/i", "file.name.replace(/\\.(zip|bimdown)$/i"],
  ['  const handleBack = useCallback(() => {',
    "  const handleOpenAreaSample = useCallback(() => {\n    const mem = createMemoryDataSource(areaSample);\n    setState({ view: 'editor', ds: mem.dataSource, name: '面积测算示例', memoryHandle: mem });\n  }, []);\n\n  const handleBack = useCallback(() => {"],
  ['      onOpenSample={import.meta.env.DEV ? handleOpenSample : undefined}',
    '      onOpenSample={import.meta.env.DEV ? handleOpenSample : undefined}\n      onOpenAreaSample={handleOpenAreaSample}'],
]);
edit('LandingPage.tsx', [
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
