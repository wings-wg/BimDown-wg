const slab = 'slab.cast-in-place-solid-structural-thickness';
const clearance = 'space.finished-minimum-clear-height';
const passage = 'door.effective-clear-width';

export const TOOL_PROFILES = {
  [slab]: {
    table: 'structure_slab', title: '现浇实心楼板结构层厚度', unit: 'm',
    convention: '以确认适用的现浇实心楼板为对象，量取有效结构层厚度，排除面层和找平层。',
    inputs: { measured: slab, upper: 'slab.structural-top-elevation', lower: 'slab.structural-bottom-elevation' },
    exportAdvice: '分列板种、是否现浇实心、有效结构层厚；用标高派生时，顶底标高须来自同一经复核的结构层测点和高程基准。',
  },
  [clearance]: {
    table: 'space', title: '房间完成面最低净高', unit: 'm',
    convention: '在适用房间使用范围内取完成地面至上方限制面的最低垂直净距，含梁、吊顶及管道包封。',
    inputs: { measured: clearance },
    exportAdvice: '补全房间用途、使用范围及完成面最低净高，记录最低点和净高分析来源。建筑层高不能替代。',
  },
  [passage]: {
    table: 'door', title: '门开启后的有效通行净宽', unit: 'm',
    convention: '按确认的开启角和测线测量，排除门扇、五金和门框的侵入。每条规则适用的门用途须单独确认。',
    inputs: { measured: passage },
    exportAdvice: '分列门用途、开启角、测线和有效通行净宽。名义门宽和洞口宽度不能替代。',
  },
} as const;

export type ToolConcept = keyof typeof TOOL_PROFILES;
export type ToolRecipe = { concept: ToolConcept; operation: 'read' | 'difference'; inputs: string[] };
export interface ToolEntry {
  id: string;
  version: 1;
  recipe: ToolRecipe;
  status: 'draft' | 'active';
  createdAt: string;
  origin: { model: string; clauseId: string };
  approvedAt?: string;
  verification?: string[];
}

export const textPresent = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const toolId = ({ concept, operation }: ToolRecipe) => `pal.${concept}.${operation}@1`;

export function parseToolRecipe(value: unknown): ToolRecipe | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || typeof data.concept !== 'string' || !Object.hasOwn(TOOL_PROFILES, data.concept) ||
      !Array.isArray(data.inputs)) return undefined;
  const concept = data.concept as ToolConcept;
  const fields = TOOL_PROFILES[concept].inputs;
  let required: string[];
  if (data.operation === 'read') required = [fields.measured];
  else if (data.operation === 'difference' && 'upper' in fields) required = [fields.upper, fields.lower];
  else return undefined;
  const inputs = data.inputs;
  if (inputs.length !== required.length || required.some((field, i) => field !== inputs[i])) return undefined;
  return { concept, operation: data.operation, inputs: required };
}

export interface ToolMeasurement {
  value: number;
  unit: 'm' | 'mm';
  source: string;
  confirmed: boolean;
  measurementGroup?: string;
}

export function executeToolRecipe(recipe: ToolRecipe, facts: ReadonlyMap<string, ToolMeasurement>) {
  const valid = parseToolRecipe(recipe);
  if (!valid) throw new Error('Unregistered tool recipe');
  const records = valid.inputs.map(input => facts.get(input));
  if (records.some(record => !record || record.confirmed !== true || !textPresent(record.source) ||
      !Number.isFinite(record.value) || !['m', 'mm'].includes(record.unit)))
    return { reason: '缺少已确认的量测、单位或来源。' } as const;
  const measurements = records as ToolMeasurement[];
  if (valid.operation === 'difference' && (!textPresent(measurements[0].measurementGroup) ||
      measurements[0].measurementGroup !== measurements[1].measurementGroup))
    return { reason: '顶底量测须属于同一测点和高程基准。' } as const;
  const parts = measurements.map(record => {
    const { coefficient, exponent } = decimalParts(record.value);
    return { coefficient, exponent: exponent - (record.unit === 'mm' ? 3 : 0) };
  });
  const [upper, lower] = parts;
  const exponent = lower ? Math.min(upper.exponent, lower.exponent) : upper.exponent;
  const align = (part: typeof upper) => part.coefficient * 10n ** BigInt(part.exponent - exponent);
  const length = align(upper) - (lower ? align(lower) : 0n);
  const value = Number(`${length}e${exponent}`);
  if (!Number.isFinite(value) || value <= 0) return { reason: '量测结果须为正的有限长度。' } as const;
  return { value, unit: 'm', measurements } as const;
}

/** Independent fixtures for the fixed primitives, not expectations supplied by the model. */
export function verifyToolRecipe(recipe: ToolRecipe) {
  const known = parseToolRecipe(recipe);
  if (!known) throw new Error('Unsupported measurement or operation');
  const fixture = (value: number, unit: 'mm' | 'm'): ToolMeasurement =>
    ({ value, unit, source: 'synthetic fixture', confirmed: true, measurementGroup: 'fixture point / datum' });
  const [first, second] = known.inputs;
  const facts = new Map([[first, fixture(100, 'mm')]]);
  if (second) facts.set(second, fixture(0, 'm'));
  if (executeToolRecipe(known, facts).value !== 0.1) throw new Error('Length conversion fixture failed');
  if (executeToolRecipe(known, new Map()).value !== undefined) throw new Error('Missing evidence fixture failed');
  facts.set(first, { ...facts.get(first)!, confirmed: false });
  if (executeToolRecipe(known, facts).value !== undefined) throw new Error('Unconfirmed evidence fixture failed');
  facts.set(first, fixture(-100, 'mm'));
  if (executeToolRecipe(known, facts).value !== undefined) throw new Error('Invalid length fixture failed');
  const checks = ['单位换算', '证据缺失', '未确认证据', '无效长度'];
  if (second) {
    facts.set(first, { ...fixture(100, 'mm'), measurementGroup: 'different point' });
    if (executeToolRecipe(known, facts).value !== undefined) throw new Error('Measurement scope fixture failed');
    checks.push('同测点与坐标基准');
  }
  return checks;
}
import { decimalParts } from './decimal.js';

