import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DEVELOPMENT_API, DEVELOPMENT_FIELDS, DEVELOPMENT_MODULES, developmentJobId, parseDevelopmentRequest,
  type DevelopmentJob, type DevelopmentRequest } from './development-request.mjs';

const jobKey = 'bimdown-development-job';
const empty = { module: 'general', title: '', current: '', desired: '', acceptance: '', constraints: '' };
const statuses = { preparing: '正在准备隔离副本', running: 'Codex 正在开发', review: '已完成，待审查',
  failed: '开发任务失败', applied: '改动已应用到当前源码' } as const;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function api<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${DEVELOPMENT_API}${path}`, { signal, ...(payload !== undefined && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BIMDown-Development': 'confirmed' },
    body: JSON.stringify(payload),
  }) });
  const output = await response.json().catch(() => undefined);
  if (!response.ok || !output)
    throw Object.assign(new Error(output?.error ?? '本机开发服务暂不可用。'), { status: response.status });
  return output as T;
}

function downloadFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function DevelopmentFeedback({ open, close, draft }: { open: boolean; close: () => void; draft?: DevelopmentRequest }) {
  const form = useRef<HTMLFormElement>(null);
  const [fields, setFields] = useState(empty);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [jobId, setJobId] = useState(() => {
    const linked = developmentJobId(window.location.search);
    try { return linked || window.sessionStorage.getItem(jobKey) || ''; } catch { return linked; }
  });
  const [job, setJob] = useState<DevelopmentJob>();
  const [pollError, setPollError] = useState('');
  const [posting, setPosting] = useState(false);
  useEffect(() => {
    setFields(draft ?? empty);
    setNotice(undefined);
  }, [draft]);

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const status = await api<DevelopmentJob>(`/jobs/${jobId}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setJob(status);
        setPollError('');
        if (status.status === 'preparing' || status.status === 'running') timer = setTimeout(poll, 1_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if ((error as { status?: number }).status === 404) {
          setPollError(message(error));
          setJobId('');
          try { window.sessionStorage.removeItem(jobKey); } catch { /* Storage is optional. */ }
        } else {
          setPollError('暂时无法读取开发进度，正在重试。');
          timer = setTimeout(poll, 2_000);
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId]);

  const running = !!jobId && (!job || job.status === 'preparing' || job.status === 'running');

  function taskFromForm() {
    if (!form.current) throw new Error('开发任务表单未打开。');
    return parseDevelopmentRequest({ ...Object.fromEntries(new FormData(form.current)),
      format: 'bimdown.development-request', version: 1 });
  }

  function download() {
    try {
      downloadFile('bimdown-development-request.json', JSON.stringify(taskFromForm(), null, 2) + '\n');
      setNotice({ text: '已下载开发任务文件。' });
    } catch (error) { setNotice({ error: true, text: message(error) }); }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (posting || running) return;
    setPosting(true);
    setNotice(undefined);
    try {
      const { id } = await api<{ id: string }>('/jobs', taskFromForm());
      setJob(undefined);
      setPollError('');
      setJobId(id);
      try { window.sessionStorage.setItem(jobKey, id); } catch { /* Storage is optional. */ }
    } catch (error) { setNotice({ error: true, text: message(error) }); }
    finally { setPosting(false); }
  }

  async function apply() {
    if (!job || posting || !window.confirm('确认把已审查的差异应用到当前源码仓库？')) return;
    setPosting(true);
    setNotice(undefined);
    try { setJob(await api<DevelopmentJob>(`/jobs/${job.id}/apply`, {})); }
    catch (error) { setNotice({ error: true, text: message(error) }); }
    finally { setPosting(false); }
  }

  return <aside id="development-feedback" className="area-panel" aria-labelledby="development-heading" hidden={!open}>
    <div className="model-check-head">
      <h2 id="development-heading">功能建议</h2>
      <button type="button" onClick={close}>关闭</button>
    </div>
    <form ref={form} onSubmit={event => void start(event)}>
      <label>改进模块<select name="module" value={fields.module}
        onChange={event => setFields(previous => ({ ...previous, module: event.target.value }))}>
        {Object.entries(DEVELOPMENT_MODULES).map(([module, label]) =>
          <option key={module} value={module}>{label}</option>)}
      </select></label>
      {Object.entries(DEVELOPMENT_FIELDS).map(([key, spec]) => {
        const field = key as keyof typeof DEVELOPMENT_FIELDS;
        const update = (value: string) => setFields(previous => ({ ...previous, [field]: value }));
        return <label key={field}>{spec.label}
          {field === 'title' ? <input name={field} value={fields[field]} onChange={event => update(event.target.value)}
            maxLength={spec.max} required /> :
            <textarea name={field} value={fields[field]} onChange={event => update(event.target.value)}
              rows={3} maxLength={spec.max} required={spec.required}
              placeholder={field === 'acceptance' ? '写明用什么输入、如何操作以及应看到的结果' : undefined} />}
        </label>;
      })}
      <div className="area-actions">
        <button type="submit" className="area-primary" disabled={posting || running}>确认并启动 Codex</button>
        <button type="button" onClick={download}>下载开发任务</button>
      </div>
    </form>
    {notice && <p className={notice.error ? 'area-error' : 'area-status'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {pollError && <p className="area-status" role="status">{pollError}</p>}
    {job && <section className="development-job" aria-label="开发结果">
      <h3>{job.title}</h3>
      <p role="status">{statuses[job.status]}{job.files.length ? ` · ${job.files.length} 个文件` : ''}</p>
      {job.error && <p className="area-error">{job.error}</p>}
      {job.log && <details open={running || undefined}>
        <summary>执行与测试日志</summary>
        <pre>{job.log}</pre>
      </details>}
      {job.patch ? <>
        <details>
          <summary>代码差异</summary>
          <ul>{job.files.map(path => <li key={path}>{path}</li>)}</ul>
          <pre>{job.patch}</pre>
        </details>
        <div className="area-actions">
          <button type="button" onClick={() => downloadFile('bimdown-development.patch', job.patch)}>下载差异</button>
          {job.status === 'review' && <button type="button" disabled={posting} onClick={() => void apply()}>应用已审查的改动</button>}
        </div>
      </> : job.status === 'review' && <p>本次执行没有产生源码差异。</p>}
    </section>}
  </aside>;
}
