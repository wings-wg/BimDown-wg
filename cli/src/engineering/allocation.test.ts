import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeAreaAllocation, type AreaAllocationCase } from './allocation.js';

const fixture = new URL('../../../research/benchmarks/allocation-input.json', import.meta.url);
const plan = JSON.parse(readFileSync(fixture, 'utf8')).cases[0] as AreaAllocationCase;

describe('engineering area allocation', () => {
  it('reproduces the hand-calculated allocation and records conservation', () => {
    const record = executeAreaAllocation(plan);
    expect(record.status).toBe('success');
    if (record.status !== 'success') throw new Error('Expected a successful allocation');
    expect(record.result.units).toEqual([
      { id: 'A', building: 'B1', internalArea: 60, sharedArea: 18, totalArea: 78 },
      { id: 'B', building: 'B1', internalArea: 40, sharedArea: 12, totalArea: 52 },
    ]);
    expect(record.validation.buildings).toEqual([{ building: 'B1', residual: 0, balanced: true }]);
    expect(record.evidence.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(executeAreaAllocation(plan)).toEqual(record);
  });

  it('blocks unreviewed plans and units without measurement evidence', () => {
    const input = plan.input!;
    expect(executeAreaAllocation({ ...plan, input: { ...input, confirmed: false } }).diagnostic?.status)
      .toBe('clarification-required');
    expect(executeAreaAllocation({ ...plan, input: { ...input, parts: input.parts.slice(1) } }).diagnostic?.status)
      .toBe('missing-data');
  });

  it('reports a cyclic plan as a calculation failure', () => {
    const input = plan.input!;
    const groups = [
      { ...input.groups[0], recipients: [{ id: 'upper' }] },
      input.groups[1],
    ];
    expect(executeAreaAllocation({ ...plan, input: { ...input, groups } })).toMatchObject({
      status: 'failed',
      diagnostic: { reason: 'Allocation cycle detected' },
    });
  });

  it('rejects duplicate node IDs, cross-building recipients and unsupported units', () => {
    const input = plan.input!;
    const duplicate = { ...input, nodes: [...input.nodes, input.nodes[0]] };
    expect(executeAreaAllocation({ ...plan, input: duplicate }).diagnostic?.reason).toMatch(/duplicate node/);
    const crossBuilding = structuredClone(input);
    crossBuilding.nodes[1].building = 'B2';
    expect(executeAreaAllocation({ ...plan, input: crossBuilding }).diagnostic?.reason).toMatch(/Invalid recipient/);
    expect(executeAreaAllocation({ ...plan, unit: 'mm2' } as unknown as AreaAllocationCase).diagnostic?.status)
      .toBe('unsupported');
  });

  it('fails verification when finite inputs overflow during allocation', () => {
    const input = structuredClone(plan.input!);
    input.parts[2].area = 1e308;
    input.parts[3].area = 1e308;
    delete input.buildingTotals;
    expect(executeAreaAllocation({ ...plan, input })).toMatchObject({
      status: 'failed',
      diagnostic: { status: 'verification-failed' },
      validation: { finiteTransfers: false, verified: false },
    });
  });
});
