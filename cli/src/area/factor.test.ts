import { describe, it, expect } from 'vitest';
import { inferAreaFactor, type AreaFeatures } from './factor.js';
import { calculateAreas, type AreaInput } from './index.js';
const base = { permanent: true, height: 2.2, variableHeight: false, publicPassage: false };
describe('automatic counting factors', () => {
  it('resolves height boundary, balconies, stairs, skywalks and walls', () => {
    const cases: [AreaFeatures, number][] = [
      [{ ...base, type: 'room', covered: true, enclosed: true }, 1],
      [{ ...base, height: 2.199, type: 'room' }, 0],
      [{ ...base, type: 'balcony', connectedToIndoor: true, enclosed: false }, 0.5],
      [{ ...base, type: 'balcony', connectedToIndoor: true, enclosed: true }, 1],
      [{ ...base, type: 'balcony', connectedToIndoor: false }, 0],
      [{ ...base, type: 'outdoor_stair', plazaStair: false, covered: true }, 0.5],
      [{ ...base, type: 'outdoor_stair', plazaStair: false, covered: false }, 0],
      [{ ...base, type: 'outdoor_stair', plazaStair: true }, 0],
      [{ ...base, type: 'skywalk', covered: true, enclosed: false }, 0.5],
      [{ ...base, type: 'skywalk', covered: true, enclosed: true }, 1],
      [{ ...base, type: 'skywalk', covered: false }, 0],
      [{ type: 'wall', wallOwnership: 'shared' }, 0.5],
      [{ type: 'wall', wallOwnership: 'private' }, 1],
      [{ ...base, type: 'room', publicPassage: true }, 0],
    ];
    for (const [features, factor] of cases) expect(inferAreaFactor(features).factor).toBe(factor);
  });
  it('does not invent missing evidence or flatten variable heights', () => {
    for (const features of [
      { type: 'balcony' }, { ...base, type: 'room', height: NaN },
      { ...base, type: 'room', covered: true, enclosed: true, variableHeight: true },
      { ...base, type: 'room', permanent: false },
      { ...base, type: 'balcony', enclosed: 'false' },
    ]) expect(inferAreaFactor(features as AreaFeatures).status).toBe('indeterminate');
  });
  it('integrates decisions and rejects missing evidence and incompatible kinds', () => {
    const input: AreaInput = { version: 1, confirmed: true, ruleSource: 'reviewed',
      nodes: [{ id: 'u', type: 'unit', building: 'b' }], groups: [],
      parts: [{ id: 'p', owner: 'u', kind: 'balcony', area: 20, factor: 'auto', source: 'model evidence', features: { ...base, type: 'balcony', enclosed: false, connectedToIndoor: true } }] };
    const result = calculateAreas(input);
    expect(result.units[0].totalArea).toBe(10);
    expect(result.parts[0].factorDecision?.rule).toBe('PDF-p5-balcony-2');
    input.parts[0].features!.connectedToIndoor = undefined;
    expect(() => calculateAreas(input)).toThrow(/Indeterminate/);
    input.parts[0].features = { type: 'wall', wallOwnership: 'private' };
    expect(() => calculateAreas(input)).toThrow(/mismatch/);
  });
});
