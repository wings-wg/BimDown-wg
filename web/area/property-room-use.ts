import type { ProjectAreaConfig } from './core/project-input.js';
import type { BoundaryRecord } from './property-boundary-review.js';

export const roomUseLabels = {
  private: '套内专有',
  allocatable: '共有可分摊',
  'non-allocatable': '计入但不分摊',
  'independent-use': '独立使用空间',
} as const;
export type PropertyRoomUseInput = {
  kind: keyof typeof roomUseLabels;
  building: string;
  scope: 'whole-building' | 'selected-units' | 'none';
  recipients: string[];
  source: string;
};
export type PropertyRoomUse = PropertyRoomUseInput & { buildingUnits: string[] };

export function buildingUnitIds(config: ProjectAreaConfig, building: string) {
  return config.nodes.filter(node => node.type === 'unit' && node.building === building).map(node => node.id).sort();
}

export function isPropertyRoomUse(value: unknown): value is PropertyRoomUse {
  const use = value as Partial<PropertyRoomUse> | null;
  const ids = (list: unknown): list is string[] => Array.isArray(list) &&
    list.every(id => typeof id === 'string' && !!id.trim()) && new Set(list).size === list.length;
  if (!use?.kind || !Object.hasOwn(roomUseLabels, use.kind) ||
      typeof use.building !== 'string' || !use.building.trim() || typeof use.source !== 'string' || !use.source.trim() ||
      !ids(use.buildingUnits) || !use.buildingUnits.length || !ids(use.recipients) ||
      !use.recipients.every(id => use.buildingUnits!.includes(id))) return false;
  if (use.kind === 'allocatable') return use.scope === 'whole-building' ? use.recipients.length === use.buildingUnits.length
    : use.scope === 'selected-units' && use.recipients.length > 0 && use.recipients.length < use.buildingUnits.length;
  return use.scope === 'none' && use.recipients.length === (use.kind === 'private' ? 1 : 0);
}

/** Record user-reviewed use and benefit scope against the existing, valid room outline. */
export function reviewPropertyRoomUse(record: BoundaryRecord, config: ProjectAreaConfig, input: PropertyRoomUseInput) {
  if (!record.reviewed) throw new Error('请先保存可用的房间边界复核记录。');
  if (!input.source.trim()) throw new Error('请填写用途、受益范围或扣除依据。');
  const units = buildingUnitIds(config, input.building);
  if (!units.length || units.some(id => config.nodes.filter(node => node.id === id).length !== 1))
    throw new Error('请选择有明确户号、没有重复归属的楼幢。');
  const owner = record.group.id ? config.nodes.find(node => node.id === record.group.id) : undefined;
  if (owner && owner.building !== input.building) throw new Error('房间已归属其他楼幢，请核对幢号。');
  if (input.kind === 'private' ? record.group.kind !== 'unit' : record.group.kind === 'unit')
    throw new Error('用途与当前房间归户冲突，请先核对归户配置。');
  const recipients = input.kind === 'private' ? [record.group.id] : input.kind !== 'allocatable' ? []
    : input.scope === 'whole-building' ? units : [...input.recipients].sort();
  const propertyUse: PropertyRoomUse = { ...input, source: input.source.trim(), buildingUnits: units, recipients };
  if (!isPropertyRoomUse(propertyUse)) throw new Error('请核对分摊范围及本幢受益户，局部范围需选本幢的部分户。');
  return { ...record, propertyUse };
}

export function currentPropertyRoomUse(record: BoundaryRecord | undefined, config: ProjectAreaConfig) {
  const use = record?.propertyUse;
  const owner = record?.group.id ? config.nodes.find(node => node.id === record.group.id) : undefined;
  if (record?.reviewed && use && (!owner || owner.building === use.building) &&
      (use.kind === 'private' ? record.group.kind === 'unit' && use.recipients[0] === record.group.id : record.group.kind !== 'unit') &&
      JSON.stringify(buildingUnitIds(config, use.building)) === JSON.stringify(use.buildingUnits))
    return use;
}
