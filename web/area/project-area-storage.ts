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
  if (config.commonRoomDrafts !== undefined && (!Array.isArray(config.commonRoomDrafts) ||
      config.commonRoomDrafts.some(item => !item || [item.level, item.elementId, item.source]
        .some(field => typeof field !== 'string' || !field.trim()))))
    throw new Error('请检查共用房间草稿的楼层、房间编号和来源。');
  return config;
}

type ConfigSource = Pick<DataSource, 'fetchText' | 'saveFile' | 'listFiles'>;
type DoorMarkWrite = { level: string; before: string; after: string };

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
    save(text: string, marks?: DoorMarkWrite) {
      parseProjectAreaConfig(text);
      // A later edit can retry after a failed write. The editor awaits the
      // latest write before taking a ZIP or folder snapshot.
      latestWrite = latestWrite.catch(() => {}).then(async () => {
        if (lastRead === undefined) throw new Error('请先读取项目配置，再保存。');
        const current = await read();
        if (current !== lastRead && current !== text)
          throw new Error('项目配置已被其他操作修改。请下载当前草稿，再读取项目配置并核对差异。');
        if (marks) {
          if (!marks.level || marks.level === '.' || marks.level === '..' || /[\\/:]/.test(marks.level))
            throw new Error('目标楼层编号不能用于保存门表。');
          const path = `${marks.level}/door.csv`;
          if (await source.fetchText(path) !== marks.before)
            throw new Error('目标楼层的门表已变化，请重新预览。');
          const changed = marks.before !== marks.after;
          if (changed) await source.saveFile(path, marks.after);
          try {
            if (await read() !== current) throw new Error('项目配置已变化，请重新预览。');
            if (text !== current) await source.saveFile(AREA_CONFIG_PATH, text);
          } catch (error) {
            if (!changed) throw error;
            try {
              if (await source.fetchText(path) !== marks.after)
                throw new Error('目标楼层门表已有其他改动。');
              await source.saveFile(path, marks.before);
            } catch {
              throw new Error('归户配置保存失败，目标门表未能恢复。请重新读取项目并核对门标记。', { cause: error });
            }
            throw error;
          }
        } else if (text !== current) await source.saveFile(AREA_CONFIG_PATH, text);
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
