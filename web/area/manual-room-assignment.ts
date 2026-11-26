import type { ProjectAreaConfig } from './core/project-input.js';
import { resolveAssignmentUnit } from './core/door-assignment.js';
import { roomKey, roomPoolId, type RoomReference } from './common-room-allocation.js';

export function assignSelectedRooms(config: ProjectAreaConfig, rooms: RoomReference[],
  unit: string, confirmMove: boolean): ProjectAreaConfig {
  if (!rooms.length) throw new Error('请至少选择一间房间。');
  const owner = resolveAssignmentUnit(config, unit.trim());
  const selections = [...config.selections];
  const removedPools = new Set<string>();
  const partIds = new Set([...selections, ...(config.parts ?? [])].map(part => part.id));
  const requested = new Map(rooms.map(room => [roomKey(room), room]));
  const commonDraftKeys = new Set(config.commonRoomDrafts?.map(roomKey));
  for (const [key, room] of requested) {
    const matches = config.selections.filter(item => item.table === 'space' && roomKey(item) === key);
    if (matches.length > 1) throw new Error(`房间 ${room.name} 有重复归属，请先核对配置。`);
    const previous = matches[0];
    const path = `${room.level}/space/${room.elementId}`;
    const source = `网页手动归户；房间 ${path}；户号 ${owner.id}；测算边界与系数待审核`;
    if (!previous) {
      if (commonDraftKeys.has(key) && !confirmMove) throw new Error(`房间 ${room.name} 已标为共用，请勾选确认改归。`);
      if (partIds.has(path)) throw new Error(`分项 ID ${path} 已存在，请核对配置。`);
      partIds.add(path);
      selections.push({
        id: path, level: room.level, table: 'space', elementId: room.elementId,
        owner: owner.id, kind: 'usable', factor: 1, source,
      });
      continue;
    }
    if (previous.owner === owner.id && previous.kind !== 'common' && previous.kind !== 'excluded') continue;
    if (!confirmMove) throw new Error(`房间 ${room.name} 已有归属，请勾选确认改归。`);
    const former = config.nodes.find(item => item.id === previous.owner);
    if (!former || former.building !== owner.building || former.type === 'excluded' || previous.kind === 'excluded')
      throw new Error(`房间 ${room.name} 的已有归属需要在配置 JSON 中核对。`);
    if (former.type === 'pool') {
      if (former.id !== roomPoolId(room) || previous.kind !== 'common' ||
        config.parts?.some(part => part.owner === former.id) ||
        selections.some(item => item !== previous && item.owner === former.id) ||
        config.groups.some(group => group.recipients.some(recipient => recipient.id === former.id)))
        throw new Error(`房间 ${room.name} 属于已有共有池，请在配置 JSON 中核对该池的分摊关系。`);
      removedPools.add(former.id);
    }
    const index = selections.indexOf(previous);
    selections[index] = {
      ...previous, owner: owner.id,
      ...(former.type === 'pool' ? { kind: 'usable', factor: 1 } : {}),
      source: `${previous.source}；${source}`,
    };
  }
  const nodes = config.nodes.filter(node => !removedPools.has(node.id));
  return { ...config, confirmed: false, selections,
    ...(config.commonRoomDrafts && { commonRoomDrafts: config.commonRoomDrafts.filter(room => !requested.has(roomKey(room))) }),
    nodes: nodes.includes(owner) ? nodes : [...nodes, owner],
    groups: config.groups.filter(group => !removedPools.has(group.pool)),
  };
}
