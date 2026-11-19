import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { calculateProjectAreasFromText, type ProjectAreaConfig } from './project-input.js';

export type { ProjectAreaConfig } from './project-input.js';

export function calculateProjectAreas(path: string, config: ProjectAreaConfig) {
  // Read archives in memory: no extraction and no archive-controlled filesystem writes.
  const archive = statSync(path).isDirectory() ? undefined : unzipSync(new Uint8Array(readFileSync(path)));
  const text = (relative: string): string | undefined => {
    if (relative.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw new Error(`Unsafe project path: ${relative}`);
    if (archive) return archive[relative] ? new TextDecoder().decode(archive[relative]) : undefined;
    const full = join(path, relative);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  };
  return calculateProjectAreasFromText(text, config);
}
