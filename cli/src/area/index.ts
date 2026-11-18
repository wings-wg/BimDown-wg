import { inferAreaFactor, type AreaFeatures, type FactorDecision } from './factor.js';
export { inferAreaFactor, type AreaFeatures, type FactorDecision } from './factor.js';
/** Explicit, reviewed area boundaries and allocation scopes; all areas are m². */
export interface AreaPart {
  id: string;
  owner: string;
  kind: 'usable' | 'wall' | 'balcony' | 'common' | 'excluded';
  area?: number;
  /** Closed XY rings in metres, outer followed by holes. */
  rings?: number[][][];
  factor: 0 | 0.5 | 1 | 'auto';
  features?: AreaFeatures;
  source: string;
}
export interface AllocationNode {
  id: string;
  building: string;
  type: 'unit' | 'pool' | 'excluded';
  basis?: number;
}
export interface AllocationGroup {
  id: string;
  pool: string;
  method: 'area' | 'equal' | 'weights';
  recipients: { id: string; weight?: number }[];
  source: string;
}
export interface AreaInput {
  version: 1;
  confirmed: boolean;
  ruleSource: string;
  nodes: AllocationNode[];
  parts: AreaPart[];
  groups: AllocationGroup[];
  /** Optional independently measured total per building, m². */
  buildingTotals?: Record<string, number>;
}
export function polygonArea(rings: number[][][]): number {
  if (!Array.isArray(rings) || !rings.length) throw new Error('Polygon requires rings');
  const areas = rings.map(r => {
    if (r.length < 4 || r.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v))) ||
        r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])
      throw new Error('Expected closed finite XY ring with at least four points');
    return Math.abs(r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0)) / 2;
  });
  const area = areas[0] - areas.slice(1).reduce((s, a) => s + a, 0);
  if (!(area > 0)) throw new Error('Polygon area must be positive');
  return area;
}
export function calculateAreas(input: AreaInput) {
  if (input.version !== 1 || input.confirmed !== true || !input.ruleSource?.trim())
    throw new Error('Version 1 and confirmed rule source required');
  const nodes = new Map<string, AllocationNode>();
  const own = new Map<string, number>();
  const received = new Map<string, number>();
  const positive = (v: number) => Number.isFinite(v) && v >= 0;
  for (const n of input.nodes) {
    if (!n.id || nodes.has(n.id) || !n.building || !['unit', 'pool', 'excluded'].includes(n.type) || (n.basis !== undefined && !positive(n.basis)))
      throw new Error(`Invalid/duplicate node: ${n.id}`);
    nodes.set(n.id, n); own.set(n.id, 0); received.set(n.id, 0);
  }
  const ids = new Set<string>();
  const measured = input.parts.map(p => {
    const n = nodes.get(p.owner);
    if (!p.id || ids.has(p.id) || !n || !p.source?.trim() || ![0, 0.5, 1, 'auto'].includes(p.factor) ||
        !['usable', 'wall', 'balcony', 'common', 'excluded'].includes(p.kind) ||
        (n.type === 'unit' && ['common', 'excluded'].includes(p.kind)) ||
        (n.type === 'pool' && !['common', 'wall'].includes(p.kind)) ||
        (n.type === 'excluded' && p.kind !== 'excluded') ||
        ((p.area === undefined) === (p.rings === undefined))) throw new Error(`Invalid area part: ${p.id}`);
    ids.add(p.id);
    const raw = p.rings ? polygonArea(p.rings) : p.area!;
    if (!positive(raw)) throw new Error(`Invalid area: ${p.id}`);
    let decision: FactorDecision | undefined;
    if (p.factor === 'auto') {
      if (!p.features) throw new Error(`Missing factor features: ${p.id}`);
      if ((p.kind === 'wall') !== (p.features.type === 'wall') || (p.kind === 'balcony') !== (p.features.type === 'balcony'))
        throw new Error(`Factor feature kind mismatch: ${p.id}`);
      decision = inferAreaFactor(p.features);
      if (decision.status !== 'resolved' || decision.factor === undefined)
        throw new Error(`Indeterminate factor (${p.id}): ${decision.reason}`);
    }
    const factor = p.factor === 'auto' ? decision!.factor! : p.factor;
    const counted = raw * factor;
    own.set(p.owner, own.get(p.owner)! + counted);
    return { ...p, factor, factorMode: p.factor === 'auto' ? 'automatic' : 'manual', factorDecision: decision, rawArea: raw, countedArea: counted };
  });
  const groups = new Map<string, AllocationGroup>();
  const groupIds = new Set<string>();
  for (const g of input.groups) {
    const pool = nodes.get(g.pool);
    if (!g.id || groupIds.has(g.id) || !pool || pool.type !== 'pool' || groups.has(g.pool) || !g.source?.trim() ||
        !['area', 'equal', 'weights'].includes(g.method) || !g.recipients.length)
      throw new Error(`Invalid/duplicate allocation group: ${g.id}`);
    groupIds.add(g.id); groups.set(g.pool, g);
    const targets = new Set<string>();
    for (const r of g.recipients) {
      const target = nodes.get(r.id);
      if (!target || target.type === 'excluded' || target.building !== pool.building || targets.has(r.id) ||
          (g.method === 'weights' && (r.weight === undefined || !positive(r.weight))))
        throw new Error(`Invalid recipient: ${r.id}`);
      targets.add(r.id);
    }
  }
  for (const n of nodes.values()) if (n.type === 'pool' && !groups.has(n.id)) throw new Error(`Unallocated pool: ${n.id}`);
  // Topological order: every pool receives all upstream allocations before distribution.
  const pending = new Map(groups);
  const allocations: { group: string; from: string; to: string; basis: number; coefficient: number; area: number }[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(g => ![...pending.values()].some(other => other.recipients.some(r => r.id === g.pool)));
    if (!ready.length) throw new Error('Allocation cycle detected');
    for (const g of ready) {
      const amount = own.get(g.pool)! + received.get(g.pool)!;
      const weights = g.recipients.map(r => g.method === 'equal' ? 1 : g.method === 'weights' ? r.weight! : (nodes.get(r.id)!.basis ?? own.get(r.id)!));
      const total = weights.reduce((a, b) => a + b, 0);
      if (!(total > 0) || !Number.isFinite(total)) throw new Error(`Zero/invalid allocation basis: ${g.id}`);
      g.recipients.forEach((r, i) => {
        const area = amount * weights[i] / total;
        received.set(r.id, received.get(r.id)! + area);
        allocations.push({ group: g.id, from: g.pool, to: r.id, basis: weights[i], coefficient: amount / total, area });
      });
      pending.delete(g.pool);
    }
  }
  const units = [...nodes.values()].filter(n => n.type === 'unit').map(n => ({ id: n.id, building: n.building, internalArea: own.get(n.id)!, sharedArea: received.get(n.id)!, totalArea: own.get(n.id)! + received.get(n.id)! }));
  const buildings = [...new Set([...nodes.values()].map(n => n.building))].map(building => {
    const members = [...nodes.values()].filter(n => n.building === building);
    const measuredArea = members.reduce((s, n) => s + own.get(n.id)!, 0);
    const excludedArea = members.filter(n => n.type === 'excluded').reduce((s, n) => s + own.get(n.id)!, 0);
    const allocatedArea = units.filter(u => u.building === building).reduce((s, u) => s + u.totalArea, 0);
    const expected = input.buildingTotals?.[building];
    if (expected !== undefined && (!positive(expected) || Math.abs(expected - measuredArea) > 0.000001)) throw new Error(`Building total mismatch: ${building}`);
    if (Math.abs(measuredArea - excludedArea - allocatedArea) > 0.000001) throw new Error(`Area balance failed: ${building}`);
    return { building, measuredArea, excludedArea, allocatedArea };
  });
  return { ruleSource: input.ruleSource, units, parts: measured, allocations, buildings };
}
