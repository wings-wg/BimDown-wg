import { useState, type FormEvent } from 'react';
import {
  CLOUD_QA_PROVIDERS, MODEL_QA_SESSION_HEADER, MODEL_QA_SETTINGS_PATH, MODEL_QA_TEST_PATH,
  type CloudQaProvider, type ModelQaInfo,
} from './model-qa-types.js';

type Props = {
  sessionId: string;
  active?: ModelQaInfo;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onChange: (sessionId: string, status: ModelQaInfo) => void;
};

export function ModelQuestionSettings({ sessionId, active, pending, setPending, onChange }: Props) {
  const [provider, setProvider] = useState<CloudQaProvider>(active?.cloudProvider ?? 'deepseek');
  const [model, setModel] = useState(active?.cloudProvider ? active.model ?? '' : CLOUD_QA_PROVIDERS.deepseek.model);
  const [key, setKey] = useState('');
  const [thinking, setThinking] = useState(active?.thinking ?? false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const preset = CLOUD_QA_PROVIDERS[provider];
  const reuseKey = Boolean(sessionId && active?.cloudProvider === provider);
  const canSubmit = !pending && !!model.trim() && (!!key.trim() || reuseKey);

  async function submit(action: 'save' | 'test' | 'reset') {
    if (pending || (action !== 'reset' && !canSubmit)) return;
    setPending(true);
    setNotice(undefined);
    try {
      const response = await fetch(action === 'test' ? MODEL_QA_TEST_PATH : MODEL_QA_SETTINGS_PATH, {
        method: action === 'reset' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(sessionId && { [MODEL_QA_SESSION_HEADER]: sessionId }) },
        body: action === 'reset' ? undefined : JSON.stringify({ cloudProvider: provider, model, apiKey: key, thinking }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '无法保存云端配置。');
      if (action === 'test') {
        setNotice({ message: '连接成功。可以保存并用于问答。' });
      } else if (action === 'reset') {
        onChange('', payload as ModelQaInfo);
        setKey('');
        setNotice({ message: '已切回服务端默认设置。' });
      } else {
        if (typeof payload.sessionId !== 'string' || !payload.status?.cloudProvider)
          throw new Error('服务端未返回有效的会话。');
        onChange(payload.sessionId, payload.status as ModelQaInfo);
        setKey('');
        setNotice({ message: '已启用云端模型。' });
      }
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : '模型设置暂不可用。', error: true });
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit('save');
  }

  return <form className="model-qa-result model-qa-settings" id="model-qa-settings" aria-label="云端模型设置" onSubmit={save}>
    <div className="model-qa-settings-fields">
      <label>云端服务<select value={provider} disabled={pending} onChange={event => {
        const next = event.target.value as CloudQaProvider;
        setProvider(next);
        setModel(active?.cloudProvider === next ? active.model ?? CLOUD_QA_PROVIDERS[next].model : CLOUD_QA_PROVIDERS[next].model);
        setKey('');
        setThinking(next === active?.cloudProvider ? active.thinking ?? false : false);
        setNotice(undefined);
      }}>
        {Object.entries(CLOUD_QA_PROVIDERS).map(([id, choice]) => <option key={id} value={id}>{choice.label}</option>)}
      </select></label>
      <label>模型名<input value={model} maxLength={160} disabled={pending} required onChange={event => {
        setModel(event.target.value);
        setNotice(undefined);
      }} /></label>
      <label>API 密钥<input type="password" value={key} maxLength={4_096} disabled={pending}
        autoComplete="off" required={!reuseKey} placeholder={reuseKey ? '留空沿用当前密钥' : '输入服务商的 API 密钥'}
        onChange={event => {
          setKey(event.target.value);
          setNotice(undefined);
        }} /></label>
    </div>
    {provider === 'deepseek' && <label className="model-qa-thinking"><input type="checkbox" checked={thinking}
      disabled={pending} onChange={event => { setThinking(event.target.checked); setNotice(undefined); }} />开启思考模式</label>}
    <p className="model-qa-settings-note">
      服务地址 {new URL(preset.endpoint).host}。连接测试只发送固定测试消息。启用后，提问会发送问题和匹配的模型证据。
    </p>
    <div className="model-qa-settings-actions">
      <button type="button" disabled={!canSubmit} onClick={() => void submit('test')}>测试连接</button>
      <button type="submit" className="model-qa-submit" disabled={!canSubmit}>保存并启用</button>
      {sessionId && <button type="button" disabled={pending} onClick={() => void submit('reset')}>切回服务端默认</button>}
    </div>
    {pending && <p role="status">正在处理…</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'model-qa-error' : 'model-qa-model'}>
      {notice.message}
    </p>}
  </form>;
}
