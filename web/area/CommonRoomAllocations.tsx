import { useState } from 'react';
import type { ProjectAreaConfig } from './core/project-input.js';
import { canEditRoomAllocation, roomKey, type listCommonRooms, type RoomAllocation, type RoomAllocationUpdate, type RoomReference } from './common-room-allocation.js';

type CommonRoom = ReturnType<typeof listCommonRooms>[number];
interface Props {
  draft: ProjectAreaConfig;
  rooms: CommonRoom[];
  level: string;
  levelNames: ReadonlyMap<string, string>;
  busy: boolean;
  locate: (room: RoomReference) => void;
  save: (rooms: RoomReference[], rule: RoomAllocationUpdate) => void;
}

export function CommonRoomAllocations({ draft, rooms, level, levelNames, busy, locate, save }: Props) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const selected = rooms.filter(item => canEditRoomAllocation(item) && checked.has(roomKey(item.room)));
  const pending = rooms.filter(item => !item.group).length;
  const pendingOnLevel = rooms.filter(item => item.room.level === level && !item.group && canEditRoomAllocation(item));
  const units = draft.nodes.filter(node => node.type === 'unit');
  const batch = selected.length > 1;

  function choose(keys: Set<string>) {
    setChecked(keys);
    setNotice(undefined);
  }

  return <section className="area-units" aria-label="共用区域">
    <h3>共用区域 {rooms.length > 0 && <small>{rooms.length} 间 · {pending} 间待设置分摊</small>}</h3>
    {rooms.length === 0 ? <p>归户后，未分给住户的同层房间会在这里显示。</p> : <>
      <div className="area-actions">
        <button type="button" disabled={busy || !pendingOnLevel.length}
          onClick={() => choose(new Set(pendingOnLevel.map(item => roomKey(item.room))))}>全选本层待设置</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => choose(new Set())}>清空选择</button>
      </div>
      <fieldset className="area-room-options" disabled={busy}>
        <legend>共用房间 · 已选 {selected.length} 间</legend>
        <div>
          {rooms.map(item => {
            const { room, group, draft: roomDraft } = item;
            const key = roomKey(room);
            const editable = canEditRoomAllocation(item);
            return <div className="area-common-room-row" key={key}>
              <label className="area-review">
                <input type="checkbox" disabled={!editable} checked={editable && checked.has(key)} onChange={event => {
                  const next = new Set(checked);
                  if (event.target.checked) next.add(key);
                  else next.delete(key);
                  choose(next);
                }} />
                <span>{levelNames.get(room.level) ?? room.level} · {room.name} <small>{room.elementId}</small>
                  <small className="area-common-room-status" title={roomDraft?.source}>
                    {editable ? (group ? '已设置' : roomDraft ? '自动规划 · 待分摊' : '待设置') : '在配置 JSON 中维护'}
                  </small>
                </span>
              </label>
              <button type="button" aria-label={`定位 ${room.name} · ${room.elementId}`}
                onClick={() => locate(room)}>定位</button>
            </div>;
          })}
        </div>
      </fieldset>
      {selected.length > 0 && <RoomAllocationForm key={JSON.stringify(selected.map(({ room, selection, group }) =>
        [roomKey(room), selection, group]))} draft={draft} selected={selected} units={units} busy={busy} save={rule => {
          try {
            save(selected.map(item => item.room), rule);
            const text = batch ? `已批量保存 ${selected.length} 间共用房间的分摊。` :
              `已保存「${selected[0].room.name}」的分摊。`;
            setNotice({ text, error: false });
          } catch (error) {
            setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
          }
        }} />}
      {notice && <p className={notice.error ? 'area-status area-error' : 'area-status'}
        role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </>}
  </section>;
}

function RoomAllocationForm({ draft, selected, units, busy, save }: Pick<Props, 'draft' | 'busy'> & {
  selected: CommonRoom[];
  units: ProjectAreaConfig['nodes'];
  save: (rule: RoomAllocationUpdate) => void;
}) {
  const batch = selected.length > 1;
  const single = batch ? undefined : selected[0];
  const pending = selected.filter(item => !item.group);
  const needsSettings = !batch || pending.length > 0;
  const settingsLevels = new Set((batch ? pending : selected).map(item => item.room.level));
  const onFloor = new Set(draft.selections.filter(item => settingsLevels.has(item.level) && item.table === 'space' &&
    item.kind !== 'excluded' && item.kind !== 'common').map(item => item.owner));
  const sameFloor = units.filter(unit => onFloor.has(unit.id));
  const initial = single?.group?.recipients.map(recipient => recipient.id) ??
    (settingsLevels.size === 1 && new Set(sameFloor.map(unit => unit.building)).size === 1 ? sameFloor.map(unit => unit.id) : []);
  const savedMethods = new Set(selected.map(item => item.group?.method));
  const defaultMethod = savedMethods.size === 1 && selected[0].group ? selected[0].group.method :
    batch && pending.length < selected.length ? '' : 'area';
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save({
      method: data.get('method') as RoomAllocation['method'],
      allocationSource: String(data.get('allocationSource')),
      settings: needsSettings ? {
        recipients: data.getAll('recipient').map(String),
        factor: Number(data.get('factor')) as RoomAllocation['factor'],
        boundarySource: String(data.get('boundarySource')),
      } : undefined,
    });
  }}>
    {batch && pending.length < selected.length && <p className="area-status">
      已设置的房间保留原接收户、计入系数和边界依据。本次更新分摊方式和分摊依据。
    </p>}
    {needsSettings && <fieldset className="area-recipients" disabled={busy}>
      <legend>{batch && pending.length < selected.length ? '待设置房间分摊给' : '分摊给'}</legend>
      <div>{units.map(unit =>
        <label className="area-review" key={unit.id}>
          <input type="checkbox" name="recipient" value={unit.id}
            checked={Object.hasOwn(overrides, unit.id) ? overrides[unit.id] : initial.includes(unit.id)}
            onChange={event => {
              const checked = event.target.checked;
              setOverrides(previous => ({ ...previous, [unit.id]: checked }));
            }} />
          {unit.id} <small>{unit.building}</small>
        </label>)}</div>
    </fieldset>}
    <div className={needsSettings ? 'area-grid' : undefined}>
      <label>分摊方式<select name="method" defaultValue={defaultMethod} required>
        {defaultMethod === '' && <option value="" disabled>请选择</option>}
        <option value="area">自身计入面积比例</option><option value="equal">等份</option>
      </select></label>
      {needsSettings && <label>计入系数<select name="factor" defaultValue={single?.selection?.factor ?? 1}>
        <option value="1">1</option><option value="0.5">0.5</option><option value="0">0</option>
      </select></label>}
    </div>
    {needsSettings && <label>边界审核依据<input name="boundarySource" required defaultValue={single?.selection?.source} /></label>}
    <label>分摊依据<input name="allocationSource" required defaultValue={single?.group?.source} /></label>
    <button type="submit" disabled={busy}>{batch ? '批量保存分摊' : '保存本房间分摊'}</button>
  </form>;
}
