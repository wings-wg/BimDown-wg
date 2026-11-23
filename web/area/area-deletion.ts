import type { ProjectAreaConfig } from './core/project-input.js';
import { roomKey, type RoomReference } from './common-room-allocation.js';

export function removeAreaRooms(config: ProjectAreaConfig, rooms: RoomReference[]): ProjectAreaConfig {
  const ids = new Set(rooms.map(roomKey));
  const removed = config.selections.filter(item => item.table === 'space' && ids.has(roomKey(item)));
  if (!removed.length) return config;

  const removedSet = new Set(removed);
  const selections = config.selections.filter(item => !removedSet.has(item));
  const affectedOwners = new Set(removed.map(item => item.owner));
  const remainingOwners = new Set([...selections, ...(config.parts ?? [])].map(item => item.owner));
  const recipients = new Set(config.groups.flatMap(group => group.recipients.map(recipient => recipient.id)));
  const emptyPools = new Set(config.nodes.filter(node => node.type === 'pool' && affectedOwners.has(node.id) &&
    !remainingOwners.has(node.id) && !recipients.has(node.id)).map(node => node.id));
  return {
    ...config, confirmed: false, selections,
    nodes: config.nodes.filter(node => !emptyPools.has(node.id)),
    groups: config.groups.filter(group => !emptyPools.has(group.pool)),
  };
}

export function removeAreaUnit(config: ProjectAreaConfig, unit: string): ProjectAreaConfig {
  if (!config.nodes.some(node => node.id === unit && node.type === 'unit')) throw new Error('找不到要删除的户。');
  const groups = config.groups.flatMap(group => {
    const recipients = group.recipients.filter(recipient => recipient.id !== unit);
    if (recipients.length === group.recipients.length) return [group];
    return recipients.length ? [{ ...group, recipients }] : [];
  });
  return {
    ...config, confirmed: false, groups,
    nodes: config.nodes.filter(node => node.id !== unit),
    selections: config.selections.filter(item => item.owner !== unit),
    ...(config.parts && { parts: config.parts.filter(part => part.owner !== unit) }),
  };
}
