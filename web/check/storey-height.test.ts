import { describe, expect, it } from 'vitest';
import { manualHeightMetres, storeyHeightMetres, suggestStoreyChoices } from './storey-height.js';

const levels = (values: Array<[string, number?]>) =>
  values.map(([id, elevation]) => ({ id, name: id, elevation }));

describe('storey-height defaults', () => {
  it('pairs unsorted model levels with the nearest higher elevation and leaves the top level open', () => {
    const suggestions = suggestStoreyChoices(levels([['roof', 7.1], ['L1', 1.1], ['L2', 4.1]]));
    expect([...suggestions]).toEqual([
      ['L1', { mode: 'upper', id: 'L2' }], ['L2', { mode: 'upper', id: 'roof' }],
    ]);
  });

  it('does not assume a pair when the closest elevation is shared or a level has no elevation', () => {
    const suggestions = suggestStoreyChoices(levels([['L1', 0], ['L2', 3], ['aux', 3], ['empty'], ['L3', 6]]));
    expect(suggestions.size).toBe(0);
  });

  it('preserves exact boundaries from decimal elevations and declared model units', () => {
    expect(storeyHeightMetres(1.1, 4.1, 1)).toBe(3);
    expect(storeyHeightMetres(-1100, 1900, 0.001)).toBe(3);
    expect(storeyHeightMetres(0, 2.999999999999, 1)).toBeLessThan(3);
    expect(storeyHeightMetres(0, 3)).toBeUndefined();
    expect(manualHeightMetres('3.25')).toBe(3.25);
    expect(manualHeightMetres('')).toBeUndefined();
    expect(manualHeightMetres('-1')).toBeUndefined();
  });
});
