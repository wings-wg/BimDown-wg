import { useState } from 'react';
import type { ProjectAreaConfig } from './core/project-input.js';
import { roomKey, type RoomReference } from './common-room-allocation.js';

interface Props {
  draft: ProjectAreaConfig;
  levelName: string;
  rooms: RoomReference[];
  planIds: ReadonlySet<string>;
  busy: boolean;
  canDelete: boolean;
  save: (rooms: RoomReference[], unit: string, confirmMove: boolean) => void;
  remove: (rooms: RoomReference[]) => void;
}

export function ManualRoomAssignment({ draft, levelName, rooms, planIds, busy, canDelete, save, remove }: Props) {
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [unit, setUnit] = useState('');
  const [confirmMove, setConfirmMove] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const owners = new Map(draft.selections.filter(item => item.table === 'space').map(item => [roomKey(item), item.owner]));
  const commonDraftKeys = new Set(draft.commonRoomDrafts?.map(roomKey));
  const byId = new Map(draft.nodes.map(node => [node.id, node]));
  const selected = rooms.filter(room => checked.has(room.elementId));
  const reassign = selected.some(room => {
    const key = roomKey(room);
    const owner = owners.get(key);
    return commonDraftKeys.has(key) || (owner && owner !== unit.trim());
  });
  const onPlan = rooms.filter(room => planIds.has(`${room.level}:${room.elementId}`) || planIds.has(room.elementId));
  const terms = query.toLowerCase().split(/[,，、]+/).map(term => term.trim()).filter(Boolean);
  const visible = rooms.filter(room => {
    const name = room.name.toLowerCase();
    const id = room.elementId.toLowerCase();
    return terms.length < 2 ? name.includes(terms[0] ?? '') || id.includes(terms[0] ?? '') :
      terms.includes(name) || terms.includes(id);
  });

  function choose(ids: Set<string>) {
    setChecked(ids);
    setConfirmMove(false);
    setNotice(undefined);
  }

  function deleteRooms() {
    if (!selected.length || !canDelete || busy) return;
    const names = selected.slice(0, 8).map(room => room.name).join('、');
    const summary = selected.length > 8 ? `${names}等 ${selected.length} 间` : names;
    if (!window.confirm(`删除「${summary}」？相关归户和测算分项将一并移除。编辑器撤销可恢复模型房间，归户与分摊需重新设置。`))
      return;
    try {
      remove(selected);
      choose(new Set());
      setNotice({ error: false, text: `已删除 ${selected.length} 间房间。` });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : String(error) });
    }
  }

  return <details>
    <summary>按房间归户</summary>
    {!rooms.length ? <p>请打开有房间的楼层。</p> : <form onSubmit={event => {
      event.preventDefault();
      try {
        save(selected, unit.trim(), confirmMove);
        choose(new Set());
        setNotice({ error: false, text: `已将 ${selected.length} 间房间归入 ${unit.trim()} 户。` });
      } catch (error) {
        setNotice({ error: true, text: error instanceof Error ? error.message : String(error) });
      }
    }}>
      <label>查找本层房间<input value={query} placeholder="房间名称或 ID，多个用逗号分隔"
        onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" disabled={busy || !onPlan.length}
        onClick={() => choose(new Set(onPlan.map(room => room.elementId)))}>使用图中选中的房间</button>
      <fieldset className="area-room-options" disabled={busy}>
        <legend>{levelName} · 已勾选 {selected.length} 间</legend>
        <div>
          {visible.length === 0 && <p>没有匹配的房间。</p>}
          {visible.map(room => {
            const owner = owners.get(roomKey(room));
            const node = owner && byId.get(owner);
            return <label className="area-review" key={room.elementId}>
              <input type="checkbox" checked={checked.has(room.elementId)} onChange={event => {
                const next = new Set(checked);
                if (event.target.checked) next.add(room.elementId);
                else next.delete(room.elementId);
                choose(next);
              }} />
              <span>{room.name} <small>{room.elementId}</small></span>
              <small className="area-current-owner">{node && node.type === 'unit' ? `${node.id} 户` :
                node && node.type === 'pool' ? '已设共用' :
                  commonDraftKeys.has(roomKey(room)) ? '已标为共用' : owner || '未归户'}</small>
            </label>;
          })}
        </div>
      </fieldset>
      <label>目标户号<input value={unit} list="area-manual-units" required placeholder="例如 102"
        disabled={busy} onChange={event => {
          setUnit(event.target.value);
          setConfirmMove(false);
          setNotice(undefined);
        }} /></label>
      <datalist id="area-manual-units">{draft.nodes.filter(node => node.type === 'unit').map(node =>
        <option value={node.id} key={node.id}>{node.building}</option>)}</datalist>
      {reassign && unit.trim() && <label className="area-review">
        <input type="checkbox" checked={confirmMove} onChange={event => {
          setConfirmMove(event.target.checked);
          setNotice(undefined);
        }} />确认改归已有房间。逐房间保存的共用分摊规则会随该房间移除。
      </label>}
      <div className="area-actions">
        <button type="submit" disabled={busy || !selected.length}>确认按房间归户</button>
        <button type="button" className="area-delete" disabled={busy || !canDelete || !selected.length}
          onClick={deleteRooms}>删除所选房间</button>
      </div>
      {notice && <p role={notice.error ? 'alert' : 'status'}
        className={notice.error ? 'area-status area-error' : 'area-status'}>{notice.text}</p>}
    </form>}
  </details>;
}
