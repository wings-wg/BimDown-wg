import { useEffect, useState } from 'react';
import type { ProjectAreaConfig } from './core/project-input.js';
import type { BoundaryRecord } from './property-boundary-review.js';
import { buildingUnitIds, currentPropertyRoomUse, roomUseLabels, type PropertyRoomUseInput } from './property-room-use.js';

export function PropertyRoomUseReview({ record, config, saving, locate, save }: {
  record?: BoundaryRecord; config: ProjectAreaConfig; saving: boolean;
  locate: (level: string, id?: string) => void; save: (input: PropertyRoomUseInput) => void;
}) {
  const previous = currentPropertyRoomUse(record, config);
  const buildings = [...new Set(config.nodes.filter(node => node.type === 'unit' && node.building).map(node => node.building))].sort();
  const assignedBuilding = config.nodes.find(node => node.id === record?.group.id)?.building;
  const [kind, setKind] = useState<PropertyRoomUseInput['kind']>('private');
  const [building, setBuilding] = useState('');
  const [scope, setScope] = useState<PropertyRoomUseInput['scope']>('none');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [source, setSource] = useState('');

  useEffect(() => {
    setKind(previous?.kind ?? (record?.group.kind === 'unit' ? 'private' : 'allocatable'));
    setBuilding(previous?.building ?? assignedBuilding ?? (buildings.length === 1 ? buildings[0] : ''));
    setScope(previous?.scope ?? 'none');
    setRecipients(previous?.recipients ?? []);
    setSource(previous?.source ?? '');
  }, [record, config]);

  if (!record?.reviewed) return <p>保存当前房间的有效边界后，可以复核部位用途及受益户。</p>;
  const units = buildingUnitIds(config, building);
  const affected = kind === 'private' ? [record.group.id].filter(Boolean) :
    kind !== 'allocatable' ? [] : scope === 'whole-building' ? units : scope === 'selected-units' ? recipients : [];
  return <form onSubmit={event => {
    event.preventDefault();
    save({ kind, building, scope: kind === 'allocatable' ? scope : 'none', recipients, source });
  }}>
    {previous && <p>已记录 {roomUseLabels[previous.kind]} · {previous.building}</p>}
    {record.propertyUse && !previous && <p>幢内户号清单有变化，请重新确认受益范围。</p>}
    <label>房间用途<select value={kind} disabled={saving} onChange={event => setKind(event.target.value as typeof kind)}>
      {Object.entries(roomUseLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>所属楼幢<select required value={building} disabled={saving} onChange={event => {
      setBuilding(event.target.value);
      setRecipients([]);
    }}>
      <option value="">选择楼幢</option>
      {buildings.map(id => <option key={id} value={id}>{id}</option>)}
    </select></label>
    {kind === 'allocatable' && <>
      <label>受益范围<select value={scope} disabled={saving} onChange={event => setScope(event.target.value as typeof scope)}>
        <option value="none">选择范围</option>
        <option value="whole-building">本幢全部户</option>
        <option value="selected-units">指定本幢部分户</option>
      </select></label>
      {scope === 'selected-units' && <fieldset className="area-recipients" disabled={saving}>
        <legend>受益户</legend>
        <div>{units.map(id => <label className="area-review" key={id}>
          <input type="checkbox" checked={recipients.includes(id)} onChange={event =>
            setRecipients(event.target.checked ? [...recipients, id] : recipients.filter(item => item !== id))} />{id}
        </label>)}</div>
      </fieldset>}
    </>}
    {affected.length > 0 && <div className="area-actions" aria-label="受影响户">
      <span>受影响户 {affected.length} 户</span>
      {affected.map(id => {
        const rooms = config.selections.filter(item => item.owner === id && item.table === 'space' &&
          item.kind !== 'common' && item.kind !== 'excluded');
        const first = rooms.find(item => item.level === record.level) ?? rooms[0];
        return first ? <button key={id} type="button" onClick={() => locate(first.level, first.elementId)}>{id}</button>
          : <span key={id}>{id}</span>;
      })}
    </div>}
    {(kind === 'non-allocatable' || kind === 'independent-use') && <p>该房间作为扣除项候选。</p>}
    <label>用途、受益范围或扣除依据<input value={source} required maxLength={2000} disabled={saving}
      onChange={event => setSource(event.target.value)} /></label>
    <button type="submit" disabled={saving}>保存用途及受益范围</button>
  </form>;
}
