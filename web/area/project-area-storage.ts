import type { DataSource } from 'bimdown-editor';
import type { ProjectAreaConfig } from './core/project-input.js';

export const AREA_CONFIG_PATH = 'project-config.json';

export function parseProjectAreaConfig(text: string): ProjectAreaConfig {
  const config = JSON.parse(text) as ProjectAreaConfig;
  if (config?.version !== 1 || !Array.isArray(config.nodes) || !Array.isArray(config.groups) ||
      !Array.isArray(config.selections) || (config.parts !== undefined && !Array.isArray(config.parts)))
    throw new Error('请提供版本 1 的面积配置，包含 nodes、groups 和 selections 数组。');
  if (typeof config.ruleSource !== 'string' || config.nodes.some(node => typeof node?.id !== 'string') ||
      config.groups.some(group => typeof group?.id !== 'string') ||
      config.selections.some(item => !item || [item.id, item.level, item.table, item.elementId, item.owner]
        .some(field => typeof field !== 'string')))
    throw new Error('请检查配置中的规则来源及对象引用。');
  return config;
}

type ConfigSource = Pick<DataSource, 'fetchText' | 'saveFile' | 'listFiles'>;

function createProjectAreaStore(source: ConfigSource) {
  let latestWrite = Promise.resolve();
  let lastRead: string | null | undefined;

  async function read() {
    const text = await source.fetchText(AREA_CONFIG_PATH);
    if (text === null && (await source.listFiles?.())?.includes(AREA_CONFIG_PATH))
      throw new Error('项目配置已存在，但无法读取。请检查文件权限。');
    return text;
  }

  return {
    load() {
      const loaded = latestWrite.catch(() => {}).then(async () => {
        lastRead = undefined;
        lastRead = await read();
        return lastRead;
      });
      latestWrite = loaded.then(() => {}, () => {});
      return loaded;
    },
    save(text: string) {
      parseProjectAreaConfig(text);
      // A later edit can retry after a failed write. The editor awaits the
      // latest write before taking a ZIP or folder snapshot.
      latestWrite = latestWrite.catch(() => {}).then(async () => {
        if (lastRead === undefined) throw new Error('请先读取项目配置，再保存。');
        const current = await read();
        if (current !== lastRead && current !== text)
          throw new Error('项目配置已被其他操作修改。请下载当前草稿，再读取项目配置并核对差异。');
        if (text !== current) await source.saveFile(AREA_CONFIG_PATH, text);
        lastRead = text;
      });
      return latestWrite;
    },
    flush() {
      return latestWrite;
    },
  };
}

const stores = new WeakMap<ConfigSource, ReturnType<typeof createProjectAreaStore>>();

export function getProjectAreaStore(source: ConfigSource) {
  let store = stores.get(source);
  if (!store) {
    store = createProjectAreaStore(source);
    stores.set(source, store);
  }
  return store;
}
