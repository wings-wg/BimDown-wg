import { roomCheckKey, type RoomClearHeightEntry } from './check-model.js';

const blankRoom: RoomClearHeightEntry = { applicability: 'pending', minimumHeight: '', usableArea: '', lowAreas: {}, source: '' };
const applicabilityOptions = [
  ['pending', '待确认'],
  ['applies', '适用 · 普通卧室或起居室'],
  ['excluded', '不适用 · 不在本条范围'],
  ['sloped', '坡屋顶卧室或起居室 · 另行核查'],
] as const;

export function RoomClearHeightFields({ rooms, thresholds, entries, edit }: {
  rooms?: Array<{ scope: string; id: string; name: string }>;
  thresholds: number[];
  entries: ReadonlyMap<string, RoomClearHeightEntry>;
  edit: (key: string, value: RoomClearHeightEntry) => void;
}) {
  return <fieldset className="model-check-levels">
    <legend>房间净高证据</legend>
    <small>核对新建住宅普通卧室和起居室的房间用途。按完成地面到上方限制面的垂直净距填写最低净高，计入梁、吊顶等限制。使用面积与低净高面积应按同一房间边界计量。</small>
    {!rooms && <p role="status">正在读取模型房间…</p>}
    {rooms?.length === 0 && <p>模型没有房间记录。</p>}
    {rooms?.map(({ scope, id, name }) => {
      const key = roomCheckKey(scope, id);
      const entry = entries.get(key) ?? blankRoom;
      const update = (patch: Partial<RoomClearHeightEntry>) => edit(key, { ...entry, ...patch });
      return <details key={key}>
        <summary>{name} · {applicabilityOptions.find(([value]) => value === entry.applicability)?.[1]}</summary>
        <label>净高条款适用性<select aria-label="净高条款适用性" value={entry.applicability}
          onChange={event => update({ applicability: event.target.value as RoomClearHeightEntry['applicability'] })}>
          {applicabilityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {entry.applicability === 'applies' && <>
          <label>最低完成面净高（m）<input type="number" step="any" min="0" value={entry.minimumHeight}
            onChange={event => update({ minimumHeight: event.target.value })} /></label>
          <label>房间使用面积（m²）<input type="number" step="any" min="0" value={entry.usableArea}
            onChange={event => update({ usableArea: event.target.value })} /></label>
          {thresholds.map(threshold => <label key={threshold}>净高低于 {threshold} m 的面积（m²）
            <input type="number" step="any" min="0" value={entry.lowAreas[threshold] ?? ''}
              onChange={event => update({ lowAreas: { ...entry.lowAreas, [threshold]: event.target.value } })} />
          </label>)}
          <label>净高和面积证据来源<input type="text" value={entry.source} placeholder="如建筑剖面与净高分析图号"
            onChange={event => update({ source: event.target.value })} /></label>
        </>}
      </details>;
    })}
  </fieldset>;
}
