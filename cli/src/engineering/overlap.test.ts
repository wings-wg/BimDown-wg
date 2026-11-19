import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeSpaceOverlap, type SpaceOverlapCase } from './overlap.js';

const fixture = new URL('../../../research/benchmarks/overlap-input.json', import.meta.url);
const plan = JSON.parse(readFileSync(fixture, 'utf8')).cases[0] as SpaceOverlapCase;

describe('projected cross-level overlap', () => {
  it('preserves holes and scoped IDs and compares at the threshold', () => {
    const record = executeSpaceOverlap(plan);
    expect(record.status).toBe('fail');
    expect(record.evidence?.area).toBe(6.5);
    expect(record.evidence?.intersection.coordinates[0]).toHaveLength(2);
    expect(record.evidence?.footprints.map(item => item.object.scope)).toEqual(['lv-1', 'lv-2']);
    expect(executeSpaceOverlap({ ...plan, rule: { ...plan.rule, threshold: 6.5 } }).status).toBe('pass');
  });

  it('normalizes units and returns zero area at an edge contact', () => {
    const millimetres = structuredClone(plan);
    millimetres.unit = 'mm';
    for (const footprint of millimetres.footprints!) {
      footprint.rings = footprint.rings.map(ring => ring.map(([x, y]) => [x * 1000, y * 1000]));
    }
    expect(executeSpaceOverlap(millimetres).evidence?.area).toBe(6.5);
    const touching = structuredClone(plan);
    touching.footprints![1].rings = [[[4,0],[5,0],[5,4],[4,4],[4,0]]];
    expect(executeSpaceOverlap(touching).evidence?.intersection.coordinates).toEqual([]);
    expect(executeSpaceOverlap(touching).evidence?.area).toBe(0);
  });

  it('retains disconnected intersection polygons', () => {
    const split = structuredClone(plan);
    split.footprints![0].rings = [[[0,0],[4,0],[4,4],[3,4],[3,1],[1,1],[1,4],[0,4],[0,0]]];
    split.footprints![1].rings = [[[0,2],[4,2],[4,3],[0,3],[0,2]]];
    const record = executeSpaceOverlap(split);
    expect(record.evidence?.intersection.coordinates).toHaveLength(2);
    expect(record.evidence?.area).toBe(2);
  });

  it('requires review and rejects same-level and invalid geometry', () => {
    expect(executeSpaceOverlap({ ...plan, footprints: undefined }).diagnostic?.status).toBe('missing-data');
    expect(executeSpaceOverlap({ ...plan, rule: { ...plan.rule, reviewed: false } }).diagnostic?.status)
      .toBe('clarification-required');
    const sameLevel = structuredClone(plan);
    sameLevel.footprints![1].object.scope = 'lv-1';
    expect(executeSpaceOverlap(sameLevel).diagnostic?.status).toBe('clarification-required');
    const invalid = structuredClone(plan);
    invalid.footprints![0].rings = [[[0,0],[4,3],[0,4],[3,0],[0,0]]];
    expect(executeSpaceOverlap(invalid).diagnostic?.status).toBe('geometry-error');
    expect(executeSpaceOverlap({ ...plan, rule: { ...plan.rule, concept: 'space.volume' } }).diagnostic?.status)
      .toBe('unsupported');
  });
});
