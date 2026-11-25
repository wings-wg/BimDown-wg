import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseToolRecipe, toolId, verifyToolRecipe, type ToolEntry, type ToolRecipe } from './src/check/core/tool-recipes.ts';
import { verifyCandidatePackage } from './src/check/pal-candidate-package.ts';

const toolLimit = 20;

export function createPalLibrary(file?: string) {
  const tools = new Map<string, ToolEntry>();
  let initialized = false;
  let queue: Promise<unknown> = Promise.resolve();

  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      if (!initialized && file) {
        const raw = await readFile(file, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (raw !== undefined) {
          const disk = JSON.parse(raw) as { version?: number; tools?: ToolEntry[] };
          if (disk.version !== 1 || !Array.isArray(disk.tools) || disk.tools.length > toolLimit)
            throw new Error('工具库文件格式无效。');
          for (const tool of disk.tools) {
            const recipe = parseToolRecipe(tool.recipe);
            if (!recipe || tool.id !== toolId(recipe) || tools.has(tool.id) || tool.version !== 1 ||
                !['draft', 'active'].includes(tool.status) || typeof tool.origin?.model !== 'string' ||
                typeof tool.origin?.clauseId !== 'string' || typeof tool.createdAt !== 'string')
              throw new Error('工具库包含无效工具。');
            if (tool.status === 'active') {
              if (typeof tool.approvedAt !== 'string') throw new Error('启用工具缺少审核记录。');
              tool.verification = verifyToolRecipe(recipe);
            }
            tools.set(tool.id, { ...tool, recipe });
          }
        }
      }
      initialized = true;
      return work();
    });
    queue = next.catch(() => {});
    return next;
  }

  async function saveAll(next: Map<string, ToolEntry>) {
    if (file) {
      await mkdir(dirname(file), { recursive: true });
      const staging = `${file}.tmp`;
      await writeFile(staging, JSON.stringify({ version: 1, tools: [...next.values()] }, null, 2) + '\n', 'utf8');
      await rename(staging, file);
    }
    for (const [id, tool] of next) tools.set(id, tool);
  }

  async function save(tool: ToolEntry) {
    await saveAll(new Map(tools).set(tool.id, tool));
    return tool;
  }

  return {
    list: () => inOrder(async () => [...tools.values()]),
    importCandidates: (input: unknown) => inOrder(async () => {
      const { origin, plans } = verifyCandidatePackage(input, [...tools.values()]);
      const next = new Map(tools);
      for (const { id: clauseId, plan, checks } of plans) {
        if (!('recipe' in plan) || next.has(plan.toolId)) continue;
        next.set(plan.toolId, { id: plan.toolId, version: 1, recipe: plan.recipe, origin: { model: origin, clauseId },
          status: 'draft', createdAt: new Date().toISOString(), verification: checks });
      }
      if (next.size > toolLimit) throw new Error('工具库容量已满。');
      if (next.size !== tools.size) await saveAll(next);
      return { tools: [...tools.values()], plans };
    }),
    draft: (input: ToolRecipe, origin: ToolEntry['origin']) => inOrder(async () => {
      const recipe = parseToolRecipe(input);
      if (!recipe) throw new Error('候选工具超出已注册的测量和运算范围。');
      const id = toolId(recipe);
      const existing = tools.get(id);
      if (existing) return existing;
      if (tools.size >= toolLimit) throw new Error('工具库容量已满。');
      return save({ id, version: 1, recipe, origin, status: 'draft', createdAt: new Date().toISOString(),
        verification: verifyToolRecipe(recipe) });
    }),
    approve: (id: string) => inOrder(async () => {
      const tool = tools.get(id);
      if (!tool) throw new Error('工具库里找不到此候选。');
      if (tool.status === 'active') return tool;
      const verification = verifyToolRecipe(tool.recipe);
      return save({ ...tool, status: 'active', approvedAt: new Date().toISOString(), verification });
    }),
  };
}
