import { useState } from 'react';
import { automaticRoomName, automaticRoomPatches, previewAutomaticRooms, useEditorDispatch, useEditorState } from 'bimdown-editor';

const area = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
type RoomPreview = ReturnType<typeof previewAutomaticRooms>;

export function AutomaticRooms() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [scope, setScope] = useState<'level' | 'project'>('level');
  const [preview, setPreview] = useState<(RoomPreview & {
    project: typeof state.project;
    document: typeof state.document;
  })>();
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState('');
  const stale = preview && (state.project !== preview.project || state.document !== preview.document ||
    state.currentLevel !== preview.document?.levelId);
  const activePreview = stale ? undefined : preview;
  const ready = !!state.document && state.document.levelId === state.currentLevel && !state.readonly && !state.groupEdit;
  const levelName = state.project?.levels.find(level => level.id === state.currentLevel)?.name || state.currentLevel;
  const selected = activePreview?.rooms.filter((_, index) => !excluded.has(index)) ?? [];

  function inspect() {
    setPreview(undefined);
    setNotice('');
    try {
      setPreview({ ...previewAutomaticRooms(state, scope), project: state.project, document: state.document });
      setExcluded(new Set());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function createRooms() {
    if (!activePreview || !selected.length || !ready) return;
    try {
      const patches = automaticRoomPatches(state, selected, activePreview.firstNumber);
      const first = selected[0];
      const last = selected[selected.length - 1];
      const firstName = automaticRoomName(first.levelName, activePreview.firstNumber);
      const lastName = automaticRoomName(last.levelName, activePreview.firstNumber + selected.length - 1);
      dispatch({ type: 'APPLY_LEVEL_EDITS', description: '自动创建房间', patches });
      setPreview(undefined);
      setNotice(`已创建 ${selected.length} 个房间（${firstName}${selected.length > 1 ? ` 至 ${lastName}` : ''}）。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  let next = activePreview?.firstNumber ?? 1;
  return (
    <details>
      <summary>自动创建房间</summary>
      <label>楼层范围<select value={scope} onChange={event => {
        setScope(event.target.value === 'project' ? 'project' : 'level');
        setPreview(undefined);
        setNotice('');
      }}>
        <option value="level">当前楼层{levelName ? `（${levelName}）` : ''}</option>
        <option value="project">全部楼层</option>
      </select></label>
      <button type="button" disabled={!ready} onClick={inspect}>识别闭合房间</button>
      {notice && <p role="status" className="area-status">{notice}</p>}
      {stale && <p role="status" className="area-status">模型或当前楼层已变化，请重新识别。</p>}
      {activePreview && <>
        <p role="status" className="area-status">
          {activePreview.rooms.length ? `找到 ${activePreview.rooms.length} 个待创建区域` : '未找到可新建的闭合区域'}
          {activePreview.existing ? `，跳过 ${activePreview.existing} 个已有房间` : ''}。
        </p>
        {!!activePreview.unresolved && <p className="area-status">有 {activePreview.unresolved} 个已有房间无法匹配闭合区域，请检查其位置。</p>}
        {!!activePreview.skipped && <p className="area-status">有 {activePreview.skipped} 个嵌套或轮廓异常的区域需手工核对。</p>}
        {!!activePreview.unscopedWalls && <p className="area-status">有 {activePreview.unscopedWalls} 段跨层边界缺少可确认的楼层范围。</p>}
        {!!activePreview.rooms.length && <>
          <p className="area-status">取消勾选不应建房的区域，例如管井。面积随模型墙线派生。</p>
          <ul className="area-parts area-room-preview">
            {activePreview.rooms.map((room, index) => {
              const checked = !excluded.has(index);
              const name = checked ? automaticRoomName(room.levelName, next++) : room.levelName;
              return <li key={index}>
                <label className="area-review">
                  <input type="checkbox" checked={checked} onChange={event => {
                    const include = event.target.checked;
                    setExcluded(previous => {
                      const updated = new Set(previous);
                      if (include) updated.delete(index);
                      else updated.add(index);
                      return updated;
                    });
                  }} />
                  <span>{name}<br /><small>定位点 {area.format(room.point.x)}, {area.format(room.point.y)}</small></span>
                </label>
                <small>{area.format(room.areaM2)} m²{room.centrelineArea ? '（墙中心线）' : ''}</small>
              </li>;
            })}
          </ul>
          <button type="button" disabled={!ready || !selected.length} onClick={createRooms}>创建所选 {selected.length} 个房间</button>
        </>}
      </>}
    </details>
  );
}
