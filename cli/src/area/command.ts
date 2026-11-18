import { readFileSync, writeFileSync } from 'node:fs';
import { calculateAreas, type AreaInput } from './index.js';
export function areaCalculate(path: string, opts: { output?: string }) {
  try {
    const result = calculateAreas(JSON.parse(readFileSync(path, 'utf8')) as AreaInput);
    const json = JSON.stringify(result, null, 2) + '\n';
    if (opts.output) writeFileSync(opts.output, json);
    else console.log(json);
  } catch (error) {
    console.error(`Area calculation failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
