import type { ProjectAreaConfig } from './core/project-input.js';

export interface RoomReference {
  level: string;
  elementId: string;
  name: string;
}

export interface RoomAllocation {
  recipients: string[];
  method: 'area' | 'equal';
  factor: 0 | 0.5 | 1;
  boundarySource: string;
  allocationSource: string;
}

type AllocationMethod = Pick<RoomAllocation, 'method' | 'allocationSource'>;
export type RoomAllocationUpdate = AllocationMethod & { settings?: Omit<RoomAllocation, keyof AllocationMethod> };

export const roomKey = (room: Pick<RoomReference, 'level' | 'elementId'>) => JSON.stringify([room.level, room.elementId]);
export const roomPoolId = (room: RoomReference) => `共有房间 ${room.level}/${room.elementId}`;

export function listCommonRooms(config: ProjectAreaConfig, rooms: RoomReference[]) {
  const types = new Map(config.nodes.map(node => [node.id, node.type]));
  const selections = new Map<string, ProjectAreaConfig['selections'][number]>();
  const groups = new Map(config.groups.map(group => [group.pool, group]));
  const unitLevels = new Set<string>();
  for (const item of config.selections) {
    if (item.table !== 'space') continue;
    selections.set(roomKey(item), item);
    if (types.get(item.owner) === 'unit' && item.kind !== 'excluded' && item.kind !== 'common') unitLevels.add(item.level);
  }
  return rooms.flatMap(room => {
    const selection = selections.get(roomKey(room));
    if (selection ? selection.kind !== 'common' || types.get(selection.owner) !== 'pool' : !unitLevels.has(room.level)) return [];
    return [{ room, selection, group: selection ? groups.get(selection.owner) : undefined }];
  });
}

export function canEditRoomAllocation({ room, selection, group }: ReturnType<typeof listCommonRooms>[number]) {
  return !selection || (selection.owner === roomPoolId(room) && selection.factor !== 'auto' && group?.method !== 'weights');
}

export function saveSelectedRoomAllocations(config: ProjectAreaConfig, rooms: RoomReference[], update: RoomAllocationUpdate) {
  const unique = [...new Map(rooms.map(room => [roomKey(room), room])).values()];
  const selected = listCommonRooms(config, unique);
  if (!selected.length || selected.length !== unique.length || selected.some(item => !canEditRoomAllocation(item)))
    throw new Error('请选择可编辑的共用房间。');
  const source = update.allocationSource.trim();
  if (!source || !['area', 'equal'].includes(update.method)) throw new Error('请填写分摊方式和分摊依据。');

  let draft = config;
  const groupChanges = new Set<string>();
  for (const item of selected) {
    if (item.group && selected.length > 1) {
      if (hasPoolDependencies(config, item.group.pool, item.selection))
        throw new Error(`「${item.room.name}」的共有池存在其他分项或分摊关系，请在配置 JSON 中核对。`);
      groupChanges.add(item.group.pool);
      continue;
    }
    if (!update.settings) throw new Error(`请补齐「${item.room.name}」的分摊对象、计入系数和边界审核依据。`);
    draft = saveRoomAllocation(draft, item.room, { ...update.settings, method: update.method, allocationSource: source });
  }
  return { ...draft, confirmed: false, groups: draft.groups.map(group => groupChanges.has(group.pool)
    ? { ...group, method: update.method, source } : group) };
}

function hasPoolDependencies(config: ProjectAreaConfig, pool: string, room: ProjectAreaConfig['selections'][number] | undefined) {
  return config.parts?.some(part => part.owner === pool) ||
    config.selections.some(item => item !== room && item.owner === pool) ||
    config.groups.some(group => group.recipients.some(recipient => recipient.id === pool)) ||
    config.groups.filter(group => group.pool === pool).length > 1;
}

/** Update one room's pool and rule together, keeping existing project configs readable by the CLI. */
export function saveRoomAllocation(config: ProjectAreaConfig, room: RoomReference, rule: RoomAllocation): ProjectAreaConfig {
  const pool = roomPoolId(room);
  const partId = `${room.level}/space/${room.elementId}`;
  const matches = config.selections.filter(item => item.table === 'space' && roomKey(item) === roomKey(room));
  const previous = matches[0];
  if (matches.length > 1 || (previous && (previous.owner !== pool || previous.id !== partId || previous.kind !== 'common')))
    throw new Error('此房间已有其他归属，请核对配置。');
  const node = config.nodes.find(item => item.id === pool);
  const otherMembers = hasPoolDependencies(config, pool, previous) || config.parts?.some(part => part.id === partId) ||
    config.selections.some(item => item !== previous && item.id === partId) ||
    config.groups.some(group => group.id === pool && group.pool !== pool);
  if (otherMembers || (node && (!previous || node.type !== 'pool'))) throw new Error('共有房间的配置 ID 已被使用。');

  if (!rule.boundarySource.trim() || !rule.allocationSource.trim()) throw new Error('请填写边界审核依据和分摊依据。');
  if (![0, 0.5, 1].includes(rule.factor) || !['area', 'equal'].includes(rule.method))
    throw new Error('请核对计入系数与分摊方式。');
  const targets = rule.recipients.map(id => config.nodes.find(item => item.id === id));
  const building = targets[0]?.building;
  if (!building || new Set(rule.recipients).size !== targets.length ||
      targets.some(target => target?.type !== 'unit' || target.building !== building))
    throw new Error('请选择至少一户，同一个共用房间须分摊给同幢的住户。');

  return {
    ...config, confirmed: false,
    nodes: [...config.nodes.filter(item => item !== node), { id: pool, type: 'pool', building }],
    selections: [...config.selections.filter(item => item !== previous), {
      id: partId, level: room.level, table: 'space', elementId: room.elementId,
      owner: pool, kind: 'common', factor: rule.factor, source: rule.boundarySource.trim(),
    }],
    groups: [...config.groups.filter(item => item.pool !== pool), {
      id: pool, pool, method: rule.method, source: rule.allocationSource.trim(),
      recipients: rule.recipients.map(id => ({ id })),
    }],
  };
}
