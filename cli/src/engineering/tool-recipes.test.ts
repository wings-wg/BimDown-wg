import { describe, expect, it } from 'vitest';
import { executeToolRecipe, parseToolRecipe, verifyToolRecipe, type ToolMeasurement, type ToolRecipe } from './tool-recipes.js';

const read: ToolRecipe = { concept: 'slab.cast-in-place-solid-structural-thickness', operation: 'read',
  inputs: ['slab.cast-in-place-solid-structural-thickness'] };
const difference: ToolRecipe = { ...read, operation: 'difference', inputs: ['slab.structural-top-elevation', 'slab.structural-bottom-elevation'] };
const fact = (value: number, unit: 'm' | 'mm', measurementGroup = 'P1/Datum'): ToolMeasurement =>
  ({ value, unit, source: 'synthetic section', confirmed: true, measurementGroup });

describe('PAL tool recipes', () => {
  it('uses only vetted concepts and ordered inputs', () => {
    expect(parseToolRecipe({ ...read, inputs: ['structure_slab.thickness'] })).toBeUndefined();
    expect(parseToolRecipe({ ...difference, inputs: [...difference.inputs].reverse() })).toBeUndefined();
    expect(parseToolRecipe({ ...read, code: 'return 1' })).toBeUndefined();
    expect(verifyToolRecipe(difference)).toHaveLength(5);
  });

  it('subtracts equivalent decimal elevations exactly at the threshold, rejects wrong group and missing evidence', () => {
    const [top, bottom] = difference.inputs;
    const inputs = new Map([[top, fact(4.1, 'm')], [bottom, fact(4000, 'mm')]]);
    expect(executeToolRecipe(difference, inputs).value).toBe(0.1);
    inputs.set(bottom, fact(4000, 'mm', 'P2/Datum'));
    expect(executeToolRecipe(difference, inputs).value).toBeUndefined();
    expect(executeToolRecipe(read, new Map([['structure_slab.thickness', fact(100, 'mm')]])).value).toBeUndefined();
  });
});
