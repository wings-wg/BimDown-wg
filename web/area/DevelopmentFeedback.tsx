import { useState, type FormEvent } from 'react';
import { DEVELOPMENT_FIELDS, DEVELOPMENT_MODULES, parseDevelopmentRequest } from './development-request.mjs';

export function DevelopmentFeedback({ open, close }: { open: boolean; close: () => void }) {
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const task = parseDevelopmentRequest({ ...Object.fromEntries(new FormData(event.currentTarget)),
        format: 'bimdown.development-request', version: 1 });
      const url = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bimdown-development-request.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ text: '已生成开发任务文件。可将文件交给 coding agent 实施。' });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : '生成开发任务失败。' });
    }
  }
  return <aside id="development-feedback" className="area-panel" aria-labelledby="development-heading" hidden={!open}>
    <div className="model-check-head">
      <h2 id="development-heading">功能建议</h2>
      <button type="button" onClick={close}>关闭</button>
    </div>
    <form onSubmit={download} onChange={() => setNotice(undefined)}>
      <label>改进模块<select name="module" defaultValue="general">
        {Object.entries(DEVELOPMENT_MODULES).map(([module, label]) =>
          <option key={module} value={module}>{label}</option>)}
      </select></label>
      {Object.entries(DEVELOPMENT_FIELDS).map(([field, spec]) => <label key={field}>{spec.label}
        {field === 'title' ? <input name={field} maxLength={spec.max} required /> :
          <textarea name={field} rows={3} maxLength={spec.max} required={spec.required}
            placeholder={field === 'acceptance' ? '写明用什么输入、如何操作以及应看到的结果' : undefined} />}
      </label>)}
      <button type="submit" className="area-primary">下载开发任务</button>
      {notice && <p className={notice.error ? 'area-error' : 'area-status'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </form>
  </aside>;
}
