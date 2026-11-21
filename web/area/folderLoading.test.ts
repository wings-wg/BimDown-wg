import { describe, expect, it, vi } from 'vitest';
import { createFileSystemDataSource } from './fileSystem.ts';
import { loadProject } from '../utils/loader.ts';

function notFound(): DOMException {
  return new DOMException('File not found', 'NotFoundError');
}

function directory(name: string, ...entries: FileSystemHandle[]): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory',
    async *values() { yield* entries; },
    async getDirectoryHandle(childName: string) {
      const child = entries.find(entry => entry.name === childName && entry.kind === 'directory');
      if (!child) throw notFound();
      return child;
    },
    async getFileHandle(childName: string) {
      const child = entries.find(entry => entry.name === childName && entry.kind === 'file');
      if (!child) throw notFound();
      return child;
    },
  } as FileSystemDirectoryHandle;
}

function projectFolder(getLevelFile: () => Promise<File>) {
  const removedMesh = vi.fn(async () => { throw notFound(); });
  const root = directory('project',
    directory('global', { name: 'level.csv', kind: 'file', getFile: getLevelFile } as FileSystemFileHandle),
    directory('mesh', { name: 'removed.glb', kind: 'file', getFile: removedMesh } as FileSystemFileHandle),
  );
  return { source: createFileSystemDataSource(root), removedMesh };
}

describe('project loading from a local folder', () => {
  it('loads floors even when an unrelated listed file cannot be opened', async () => {
    const { source, removedMesh } = projectFolder(async () =>
      new File(['id,name,elevation\nlv-1,F1,0\nlv-2,F2,3.1\n'], 'level.csv'));
    const project = await loadProject(source);
    expect(project.levels.map(level => level.name)).toEqual(['F1', 'F2']);
    expect(removedMesh).not.toHaveBeenCalled();
  });

  it('reports a listed level table that could not be read', async () => {
    const { source } = projectFolder(async () => { throw notFound(); });
    await expect(loadProject(source)).rejects.toThrow('Could not read global/level.csv');
  });

  it('reuses the actual listing failure instead of reporting an empty project', async () => {
    const denied = new DOMException('Access denied', 'NotAllowedError');
    const root = { values() { throw denied; } } as unknown as FileSystemDirectoryHandle;
    await expect(loadProject(createFileSystemDataSource(root))).rejects.toBe(denied);
  });
});
