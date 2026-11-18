import { describe, it, expect } from 'vitest';
import { calculateAreas, polygonArea, type AreaInput } from './index.js';
const sample = (): AreaInput => ({
  version: 1, confirmed: true, ruleSource: '建筑面积分摊.pdf 第4—6页，人工确认',
  nodes: [{ id: 'a', type: 'unit', building: 'b' }, { id: 'b', type: 'unit', building: 'b' }, { id: 'p', type: 'pool', building: 'b' }],
  parts: [
    { id: 'a1', owner: 'a', kind: 'usable', area: 80, factor: 1, source: 'reviewed' },
    { id: 'a2', owner: 'a', kind: 'balcony', area: 40, factor: 0.5, source: 'reviewed' },
    { id: 'b1', owner: 'b', kind: 'usable', area: 200, factor: 1, source: 'reviewed' },
    { id: 'p1', owner: 'p', kind: 'common', area: 30, factor: 1, source: 'reviewed' },
  ],
  groups: [{ id: 'g', pool: 'p', method: 'area', recipients: [{ id: 'a' }, { id: 'b' }], source: 'reviewed' }],
});
describe('area measurement and allocation', () => {
  it('measures half area and allocates proportionally', () => {
    const r = calculateAreas(sample());
    expect(r.units.map(u => u.totalArea)).toEqual([110, 220]);
    expect(r.buildings[0].measuredArea).toBe(330);
  });
  it('distributes upstream allocations before downstream pools', () => {
    const s = sample();
    s.nodes.push({ id: 'up', building: 'b', type: 'pool' });
    s.parts.push({ id: 'up1', owner: 'up', kind: 'common', area: 60, factor: 1, source: 'reviewed' });
    s.groups.push({ id: 'upg', pool: 'up', method: 'weights', recipients: [{ id: 'p', weight: 1 }], source: 'agreement' });
    expect(calculateAreas(s).units.map(u => u.sharedArea)).toEqual([30, 60]);
  });
  it('rejects cycles, cross-building recipients and unconfirmed inputs', () => {
    const s = sample(); s.groups[0].recipients = [{ id: 'p' }];
    expect(() => calculateAreas(s)).toThrow(/cycle/);
    const t = sample(); t.nodes[0].building = 'other';
    expect(() => calculateAreas(t)).toThrow(/recipient/);
    const u = sample(); u.confirmed = false;
    expect(() => calculateAreas(u)).toThrow(/confirmed/);
  });
  it('rejects duplicate parts, zero denominator and inconsistent totals', () => {
    const s = sample(); s.parts.push(s.parts[0]);
    expect(() => calculateAreas(s)).toThrow(/part/);
    const t = sample(); t.nodes[0].basis = 0; t.nodes[1].basis = 0;
    expect(() => calculateAreas(t)).toThrow(/basis/);
    const u = sample(); u.buildingTotals = { b: 400 };
    expect(() => calculateAreas(u)).toThrow(/mismatch/);
  });
  it('handles holes and rejects unclosed rings', () => {
    expect(polygonArea([[[0,0],[10,0],[10,10],[0,10],[0,0]], [[1,1],[2,1],[2,2],[1,2],[1,1]]])).toBe(99);
    expect(() => polygonArea([[[0,0],[1,0],[0,1],[2,2]]])).toThrow(/closed/);
  });
});
