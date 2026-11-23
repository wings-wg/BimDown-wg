export const MODEL_QA_PATH = '/api/bimdown/model-qa';
export const MODEL_QA_SETTINGS_PATH = `${MODEL_QA_PATH}/settings`;
export const MODEL_QA_TEST_PATH = `${MODEL_QA_SETTINGS_PATH}/test`;
export const MODEL_QA_SESSION_HEADER = 'x-bimdown-qa-session';
export const CLOUD_QA_PROVIDERS = {
  deepseek: { label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini' },
  dashscope: { label: '阿里云百炼（北京按量付费）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
} as const;
export type CloudQaProvider = keyof typeof CLOUD_QA_PROVIDERS;
export const MAX_QUESTION_LENGTH = 1_200;
export const MAX_EVIDENCE_ITEMS = 20;

export interface ModelEvidence {
  label: string;
  source: string;
  facts: Record<string, unknown>;
  target?: { level: string; elementId: string };
}

export interface ModelQuestion {
  question: string;
  previousQuestion?: string;
  evidence: ModelEvidence[];
}

export interface ModelQaStatus {
  model: string;
  host: string;
  cloudProvider?: CloudQaProvider;
  thinking?: boolean;
}

export type ModelQaInfo = Partial<ModelQaStatus> & { expired?: boolean };
