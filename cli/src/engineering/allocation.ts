import { createHash } from 'node:crypto';
import { calculateAreas, type AreaInput } from '../area/index.js';

export interface AreaAllocationCase {
  tool: 'area-allocation';
  modelVersion: string;
  unit: 'm2';
  input?: AreaInput;
}

/** Execute an explicitly reviewed allocation plan against one model snapshot. */
export function executeAreaAllocation(plan: AreaAllocationCase) {
  const base = { tool: 'area-allocation@1', modelVersion: plan.modelVersion, unit: plan.unit };
  if (plan.unit !== 'm2') {
    return { ...base, status: 'input-incomplete' as const,
      diagnostic: { status: 'unsupported', reason: 'Allocation requires square metres and rings in metres' } };
  }
  const input = plan.input;
  if (typeof plan.modelVersion !== 'string' || !plan.modelVersion.trim() ||
      !Array.isArray(input?.nodes) || !Array.isArray(input.parts) || !Array.isArray(input.groups) ||
      !input.parts.length || !input.nodes.some(node => node?.type === 'unit')) {
    return { ...base, status: 'input-incomplete' as const,
      diagnostic: { status: 'missing-data', reason: 'Model version, allocation lists, measured parts and a unit are required' } };
  }
  if (input.confirmed !== true || typeof input.ruleSource !== 'string' || !input.ruleSource.trim()) {
    return { ...base, status: 'input-incomplete' as const,
      diagnostic: { status: 'clarification-required', reason: 'Allocation plan and its source require review' } };
  }
  const measuredOwners = new Set(input.parts.map(part => part?.owner));
  const unmeasured = input.nodes.find(node => node?.type === 'unit' && !measuredOwners.has(node.id));
  if (unmeasured) {
    return { ...base, status: 'input-incomplete' as const,
      diagnostic: { status: 'missing-data', reason: `Unit ${unmeasured.id} requires an explicit area part` } };
  }

  const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const evidence = { inputDigest, ruleSource: input.ruleSource, inputVersion: input.version };
  try {
    const result = calculateAreas(input);
    const tolerance = 0.000001;
    const buildings = result.buildings.map(building => {
      const residual = building.measuredArea - building.excludedArea - building.allocatedArea;
      const finite = Number.isFinite(residual);
      return { building: building.building, residual: finite ? residual : null,
        balanced: finite && Math.abs(residual) <= tolerance };
    });
    const finiteTransfers = result.allocations.every(transfer =>
      Number.isFinite(transfer.area) && Number.isFinite(transfer.coefficient));
    const verified = finiteTransfers && buildings.every(building => building.balanced);
    const validation = { tolerance, buildings, finiteTransfers, verified };
    if (!verified) return { ...base, evidence, validation, status: 'failed' as const,
      diagnostic: { status: 'verification-failed', reason: 'Allocation totals or transfers failed verification' } };
    return { ...base, evidence, validation, result, status: 'success' as const };
  } catch (error) {
    return { ...base, evidence, status: 'failed' as const,
      diagnostic: { status: 'calculation-failed', reason: (error as Error).message } };
  }
}
