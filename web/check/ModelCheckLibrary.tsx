import { useState } from 'react';
import { TOOL_PROFILES, type ToolEntry } from './core/tool-recipes.js';

export function ModelCheckLibrary({ tools, disabled, approve }: {
  tools: ToolEntry[];
  disabled: boolean;
  approve: (tool: ToolEntry) => Promise<void>;
}) {
  const [reviewed, setReviewed] = useState(new Set<string>());
  const [saving, setSaving] = useState<string>();
  const drafts = tools.filter(tool => tool.status === 'draft').length;
  return <details open={drafts > 0 ? true : undefined}>
    <summary>PAL 工具库 · {tools.length - drafts} 已启用 · {drafts} 待审核</summary>
    <small>编译优先检索已启用工具。候选工具需确认测量口径，启用前会重跑固定验证用例。</small>
    {tools.length > 0 && <ul className="model-check-list">{tools.map(tool => {
      const profile = TOOL_PROFILES[tool.recipe.concept];
      return <li key={tool.id}>
        <strong>{profile.title} · {tool.status === 'active' ? '已启用' : '待审核'}</strong>
        <small>{tool.id} · {tool.recipe.operation === 'read' ? '读取已确认量测' : '同测点高程相减'}</small>
        <small>{profile.convention}</small>
        <small>输入 {tool.recipe.inputs.join('、')}，输出 m。来源 {tool.origin.model} · {tool.origin.clauseId}</small>
        <small>验证通过：{tool.verification?.join('、')}</small>
        {tool.status === 'draft' && <>
          <label className="area-review">
            <input type="checkbox" aria-label={`确认工具口径 ${profile.title}`} checked={reviewed.has(tool.id)}
              onChange={event => {
                const checked = event.target.checked;
                setReviewed(previous => {
                  const next = new Set(previous);
                  if (checked) next.add(tool.id); else next.delete(tool.id);
                  return next;
                });
              }} />
            我已检查输入、量测口径和验证结果
          </label>
          <button type="button" disabled={disabled || !!saving || !reviewed.has(tool.id)} onClick={() => {
            setSaving(tool.id);
            void approve(tool).finally(() => setSaving(undefined));
          }}>审核并启用工具</button>
        </>}
      </li>;
    })}</ul>}
  </details>;
}
