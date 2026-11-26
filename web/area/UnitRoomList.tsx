import { useEffect, useState, type Ref } from 'react';
import { unitRoomView, useEditorDispatch, useEditorState, ZOOM_TO_EVENT } from 'bimdown-editor';
import type { ProjectAreaConfig } from './core/project-input.js';
import { orderAssignedUnits } from './unit-list-order.js';

type SelectionRequest = { levelId: string; rooms: ReadonlySet<string> };

export function UnitRoomList({ draft, sectionRef, busy, remove }: {
  draft: ProjectAreaConfig | undefined;
  sectionRef: Ref<HTMLElement>;
  busy: boolean;
  remove: (unitId: string) => void;
}) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [activeUnit, setActiveUnit] = useState('');
  const [request, setRequest] = useState<SelectionRequest>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();

  // Map by level before deduplication. A room ID can recur on different floors.
  const units = new Map(draft?.nodes.filter(node => node.type === 'unit').map(node =>
    [node.id, new Map<string, Set<string>>()] as const));
  for (const room of draft?.selections ?? []) {
    if (room.table !== 'space' || room.kind === 'common' || room.kind === 'excluded') continue;
    const levels = units.get(room.owner);
    if (!levels) continue;
    const rooms = levels.get(room.level) ?? new Set<string>();
    rooms.add(room.elementId);
    levels.set(room.level, rooms);
  }
  const levelLabels = new Map(state.project?.levels.map(level => [level.id, level.name || level.id]));

  function showRooms(unitId: string, levels: Map<string, Set<string>>, levelId?: string) {
    setActiveUnit(unitId);
    setNotice(undefined);
    const target = levelId ?? (levels.has(state.currentLevel) ? state.currentLevel :
      [...levelLabels.keys()].find(id => levels.has(id)));
    const rooms = target === undefined ? undefined : levels.get(target);
    if (!target || !levelLabels.has(target) || !rooms) {
      setRequest(undefined);
      setNotice({ text: '当前模型中找不到该户的房间，请核对归户配置。' });
      return;
    }
    if (state.viewMode !== '2d') dispatch({ type: 'SET_VIEW_MODE', mode: '2d' });
    if (state.activeDiscipline !== 'architecture' && state.activeDiscipline !== 'all') {
      dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    }
    if (target !== state.currentLevel) dispatch({ type: 'SET_LEVEL', levelId: target });
    setRequest({ levelId: target, rooms });
  }

  useEffect(() => {
    if (!request || state.viewMode !== '2d') return;
    const view = unitRoomView(state, request.levelId, request.rooms);
    if (!view) return;
    const roomLayer = 'architecture/space';
    if (view.ids.length && !state.visibleLayers.has(roomLayer)) {
      dispatch({ type: 'SET_VISIBLE_LAYERS', keys: new Set([...state.visibleLayers, roomLayer]) });
    }
    dispatch({ type: 'SELECT', ids: view.ids, exact: true });
    if (view.bounds) window.dispatchEvent(new CustomEvent(ZOOM_TO_EVENT, { detail: view.bounds }));
    setNotice(view.missing ? { text: `已选中 ${view.ids.length} 间，${view.missing} 间在该楼层找不到。` } : undefined);
    setRequest(undefined);
  }, [request, state, dispatch]);

  function deleteUnit(unitId: string) {
    if (busy || !window.confirm(`删除 ${unitId} 户？房间会保留，归户与测算分项将移除。相关共用分摊需要重新审核。`)) return;
    try {
      remove(unitId);
      if (activeUnit === unitId) {
        setActiveUnit('');
        setRequest(undefined);
        dispatch({ type: 'CLEAR_SELECTION' });
      }
      setNotice({ text: `已删除 ${unitId} 户，原房间已解除归户。` });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  }

  const activeLevels = units.get(activeUnit);
  return (
    <section ref={sectionRef} className="area-units" aria-label="已归户">
      <h3>已归户</h3>
      {units.size === 0 ? <p className="area-status">
        {draft ? '确认批量归户后，户号和房间数会显示在这里。' : '修正配置 JSON 后可查看已归户房间。'}
      </p> : <ul className="area-unit-list">
        {orderAssignedUnits(units, state.project?.levels ?? []).map(([unitId, levels]) => {
          const count = [...levels.values()].reduce((total, rooms) => total + rooms.size, 0);
          return <li key={unitId}>
            <button type="button" aria-pressed={activeUnit === unitId} disabled={!count}
              onClick={() => showRooms(unitId, levels)}>
              <span>{unitId}</span><small>{count} 间</small>
            </button>
            <button type="button" className="area-delete" aria-label={`删除 ${unitId} 户`} disabled={busy}
              onClick={() => deleteUnit(unitId)}>删除</button>
          </li>;
        })}
      </ul>}
      {activeLevels && activeLevels.size > 1 && <div className="area-unit-levels" aria-label="该户的楼层">
        {[...activeLevels].sort(([a], [b]) => (levelLabels.get(a) ?? a).localeCompare(levelLabels.get(b) ?? b, 'zh-CN', { numeric: true }))
          .map(([id, rooms]) => <button type="button" key={id} aria-pressed={state.currentLevel === id}
            onClick={() => showRooms(activeUnit, activeLevels, id)}>
            {levelLabels.get(id) ?? id} · {rooms.size} 间
          </button>)}
      </div>}
      {notice && <p className={notice.error ? 'area-status area-error' : 'area-status'}
        role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </section>
  );
}
