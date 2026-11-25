type Definition = {
  field?: string;
  values?: readonly string[] | 'level-name' | 'element-target';
  syntax: string;
  examples: readonly string[];
  match: (request: string) => string | true | undefined;
};

const scope = (text: string) => /^(?:本项目)?(?:全部楼层|所有楼层|各楼层|每个楼层|全楼|整栋)$/.test(text) ? 'project'
  : /^(?:当前楼层|本楼层|当前层|本层)$/.test(text) ? 'level' : undefined;
const view = (text: string) => /^(?:3d|三维)(?:视图|模式|模型)?$/.test(text) ? '3d'
  : /^(?:(?:2d|二维)(?:视图|模式|模型)?|平面(?:视图|图)?)$/.test(text) ? '2d' : undefined;

function levelPlanTarget(request: string) {
  const target = /^(?:现在|先)?(?:显示|查看|打开|切换到|切到|返回(?:到)?|回到)(?:楼层)?([\p{L}\p{N}_-]{1,80}?)(?:的)?(?:(?:2d|二维)(?:视图|平面图)?|平面图|平面视图)$/u.exec(request)?.[1];
  return target && target !== '模型' && !view(target) ? target : undefined;
}

const displays = {
  '显示网格': 'grid-on', '隐藏网格': 'grid-off', '关闭网格': 'grid-off',
  '显示构件编号': 'numbers-on', '隐藏构件编号': 'numbers-off', '关闭构件编号': 'numbers-off',
  '打开小地图': 'minimap-on', '显示小地图': 'minimap-on', '隐藏小地图': 'minimap-off', '关闭小地图': 'minimap-off',
} as const;
const areaWorkflows = {
  '运行面积测算': 'calculate', '运行面积测算与分摊': 'calculate', '开始面积测算': 'calculate', '计算面积分摊': 'calculate',
  '按入户门归户': 'doors', '打开入户门归户': 'doors', '按房间归户': 'rooms', '打开房间归户': 'rooms',
  '按共用房间分摊': 'allocation', '设置共用房间分摊': 'allocation', '打开共用房间分摊': 'allocation',
} as const;
const pick = <T extends Record<string, string>>(options: T, text: string):
  T[keyof T] | undefined => Object.hasOwn(options, text) ? options[text] as T[keyof T] : undefined;

const deletionTables = { 门: 'door', 窗: 'window', 房间: 'space', 墙: 'wall', 结构墙: 'structure_wall',
  柱: 'column', 结构柱: 'structure_column', 楼板: 'slab', 结构板: 'structure_slab', 梁: 'beam',
  风管: 'duct', 管道: 'pipe', 楼梯: 'stair' } as const;
const elementIdPattern = /^[a-z][a-z0-9_-]*-\d+$/;
function deletionTarget(request: string) {
  if (/^删除(?:当前)?(?:已)?选中(?:的)?(?:构件|对象)?$/.test(request)) return 'selected';
  const category = /^(?:在(?:当前楼层|当前层|本层))?删除(?:(?:当前楼层|当前层|本层)(?:的)?)?(?:全部|所有)(.+)$/.exec(request)?.[1];
  const table = category && pick(deletionTables, category);
  if (table) return `table:${table}`;
  const id = /^删除(?:(?:当前楼层|当前层|本层)(?:的)?)?(?:(?:构件|对象)(?:编号)?)?(.+)$/.exec(request)?.[1];
  return id && elementIdPattern.test(id) ? `id:${id}` : undefined;
}

export function resolveDeleteIds(target: string, level: string, elements: ReadonlyMap<string, { tableName: string }>,
  selected: ReadonlySet<string>) {
  if (target.startsWith('id:')) return [...elements.keys()].filter(id => id.toLowerCase() === target.slice(3)).slice(0, 2);
  if (target.startsWith('table:')) return [...elements].filter(([, element]) => element.tableName === target.slice(6)).map(([id]) => id);
  if (target !== 'selected') return [];
  const ids = [...selected].map(id => id.includes(':') ? (id.startsWith(`${level}:`) ? id.slice(level.length + 1) : '') : id);
  return ids.some(id => !elements.has(id)) ? [] : [...new Set(ids)];
}

export const editorCommands = {
  'editor.set-view': {
    field: 'mode', values: ['2d', '3d'],
    syntax: '切换编辑器视图。询问如何切换或比较视图属于问答。',
    examples: ['切换到3D视图', '返回2D视图'],
    match: (r: string) => view(/^(?:(?:把|将)(?:这个)?模型(?:的视图|的显示方式)?)?(?:切换(?:到|成|为)?|切(?:到|成)|改(?:为|成)|进入|打开|显示|返回(?:到)?|回到)(?:模型的)?(.+)$/.exec(r)?.[1] ?? ''),
  },
  'editor.show-level-plan': {
    field: 'target', values: 'level-name',
    syntax: '切换至指定楼层的二维平面视图。target 引用原文中的楼层名称、编号或相对指代。',
    examples: ['显示F1的2D视图'],
    match: levelPlanTarget,
  },
  'editor.show-floors': {
    field: 'mode', values: ['all', 'current', 'current+below'],
    syntax: '切换到3D并显示全部楼层、当前楼层或当前楼层及以下。',
    examples: ['显示全部楼层', '只显示当前楼层', '显示当前楼层及以下'],
    match: (r: string) => {
      if (/^(?:在三维中|在3d中)?(?:显示|查看)(?:全部楼层|所有楼层|全楼|整栋)$/.test(r)) return 'all';
      if (/^(?:在三维中|在3d中)?(?:(?:只|仅)显示|单独显示)(?:当前楼层|当前层|本层)$/.test(r)) return 'current';
      if (/^(?:在三维中|在3d中)?显示(?:当前楼层|当前层|本层)(?:及以下|以下|及下方)(?:楼层)?$/.test(r)) return 'current+below';
    },
  },
  'editor.go-level': {
    field: 'target', values: 'level-name',
    syntax: '定位或切换楼层，target 原样引用楼层名称、编号、上层或下层。',
    examples: ['切换到F2', '上一层', '下一层'],
    match: (r: string) => {
      if (/^(?:切换到|转到|去|跳到)?上(?:一)?层$/.test(r)) return '上层';
      if (/^(?:切换到|转到|去|跳到)?下(?:一)?层$/.test(r)) return '下层';
      if (levelPlanTarget(r)) return undefined;
      const named = /^(?:切换到|转到|跳到|打开|定位到|去)(楼层)?(.+)$/.exec(r);
      if (!named || /哪|什么|怎么|如何|几层|[?？,;]|然后|同时|并且/.test(named[2])) return undefined;
      return named[1] || /^(?:f-?\d+|lv-[a-z\d_-]+|b\d+|地下.+|(?:第)?[\d一二三四五六七八九十负]+(?:楼|层)|首层|底层|顶层|屋面|屋顶|机房顶|.+层)$/u.test(named[2])
        ? named[2] : undefined;
    },
  },
  'editor.clear-selection': {
    syntax: '取消选中的构件。',
    examples: ['取消选择'],
    match: (r: string) => /^(?:取消(?:全部)?(?:选择|选中)|清空选择|清除选择|取消选中构件)$/.test(r) || undefined,
  },
  'editor.fit-plan': {
    syntax: '适应二维平面视图。',
    examples: ['全图显示'],
    match: (r: string) => /^(?:全图显示|显示全图|适应视图|缩放到全图|适应平面视图)$/.test(r) || undefined,
  },
  'editor.zoom-view': {
    field: 'direction', values: ['in', 'out'],
    syntax: '缩放当前二维或三维模型视图一档。in 为放大、拉近，out 为缩小、拉远。请求适应全图使用 editor.fit-plan。',
    examples: ['放大当前视图', '缩小当前视图'],
    match: (r: string) => {
      const direction = /^(放大|缩小)(?:当前)?(?:视图)?$/.exec(r)?.[1];
      if (direction) return direction === '放大' ? 'in' : 'out';
    },
  },
  'editor.display': {
    field: 'option', values: ['grid-on', 'grid-off', 'numbers-on', 'numbers-off', 'minimap-on', 'minimap-off'],
    syntax: '在二维视图显示或隐藏网格、构件编号和小地图。',
    examples: ['显示网格', '隐藏构件编号', '打开小地图'],
    match: (r: string) => pick(displays, r),
  },
  'editor.history': {
    field: 'operation', values: ['undo', 'redo'],
    syntax: '执行一次编辑器撤销或重做。',
    examples: ['撤销上一步', '重做上一步'],
    match: (r: string) => /^(?:撤销|撤回)(?:刚才的操作|上一步|上一项操作)?$/.test(r) ? 'undo'
      : /^重做(?:上一步|上一次操作)?$/.test(r) ? 'redo' : undefined,
  },
  'editor.delete': {
    field: 'target', values: 'element-target',
    syntax: '准备删除当前楼层的明确对象。target 使用 selected、id:构件ID 或 table:表名。始终要求界面确认。',
    examples: ['删除选中的构件', '删除d-1', '删除本层全部门'],
    match: deletionTarget,
  },
  'editor.preview-rooms': {
    field: 'scope', values: ['level', 'project'],
    syntax: '识别闭合房间并准备预览。scope 为 level（明确要求当前楼层）或 project（明确要求全部楼层）。交由用户确认后创建。',
    examples: ['在所有楼层自动创建房间', '在当前楼层自动创建房间'],
    match: (r: string) => {
      const match = /^(?:自动)?(?:在|为|对)?(.+?)(?:中|内)?(?:自动)?(?:创建|生成)房间$/.exec(r) ??
        /^(?:自动)?(?:创建|生成)(.+?)(?:的)?房间$/.exec(r);
      return match ? scope(match[1]) : undefined;
    },
  },
  'editor.open-panel': {
    field: 'panel', values: ['area', 'check', 'feedback'],
    syntax: '打开面积测算、模型核查或功能建议。',
    examples: ['打开面积测算与分摊', '打开模型核查', '打开功能建议'],
    match: (r: string) => {
      const match = /^(?:打开|进入|转到|显示)(面积测算(?:与分摊)?|模型核查|功能建议)(?:页面|面板)?$/.exec(r);
      return match ? ({ 模型核查: 'check', 功能建议: 'feedback' }[match[1]] ?? 'area') : undefined;
    },
  },
  'editor.area-workflow': {
    field: 'task', values: ['calculate', 'outlines-level', 'outlines-project', 'doors', 'rooms', 'allocation'],
    syntax: '按现有配置运行面积测算，或进入已有的测算轮廓、归户和共有分摊操作。生成轮廓先确认范围。',
    examples: ['运行面积测算', '给当前楼层生成测算轮廓', '给所有楼层生成测算轮廓', '按入户门归户', '按房间归户', '设置共用房间分摊'],
    match: (r: string) => {
      const direct = pick(areaWorkflows, r);
      if (direct) return direct;
      const match = /^(?:在|给|为)?(.+?)生成(?:房间)?测算轮廓$/.exec(r) ?? /^生成(.+?)(?:的)?(?:房间)?测算轮廓$/.exec(r);
      const requested = match && scope(match[1]);
      return requested ? `outlines-${requested}` : undefined;
    },
  },
  'editor.run-check': {
    syntax: '对核查面板当前加载并审核的条款运行核查。',
    examples: ['运行模型核查'],
    match: (r: string) => /^(?:运行|开始|执行)(?:当前|已审核的)?模型核查$/.test(r) || undefined,
  },
  'editor.help': {
    syntax: '列出已注册的操作命令。',
    examples: ['可用命令'],
    match: (r: string) => /^(?:(?:查看|显示|列出)?(?:可用命令|操作命令)|有哪些命令|命令帮助)$/.test(r) || undefined,
  },
} as const satisfies Record<string, Definition>;

type Commands = typeof editorCommands;
type CommandAction = keyof Commands;
type Args<Entry> = Entry extends { field: infer Key extends string; values: infer Values }
  ? { [K in Key]: Values extends readonly (infer Value)[] ? Value : string } : Record<never, never>;
export type EditorIntent = { [K in CommandAction]: { action: K } & Args<Commands[K]> }[CommandAction];
export type WorkspacePanel = Extract<EditorIntent, { action: 'editor.open-panel' }>['panel'];
export type WorkspaceCommand = Extract<EditorIntent, { action: 'editor.run-check' | 'editor.area-workflow' }>;
export type WorkspaceCommandRequest = { plan: WorkspaceCommand; level: string };

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s/g, '');
const commands = Object.entries(editorCommands) as [CommandAction, Definition][];
export const editorCommandExamples = commands.flatMap(([, command]) => [...command.examples]);
export const editorCommandPrompt = commands.map(([action, command]) => {
  const args = command.field ? `，参数 ${command.field}` : '';
  if (Array.isArray(command.values)) return `${action}${args} 为 ${command.values.join(' / ')}。${command.syntax}`;
  if (command.values === 'level-name') return `${action}${args} 为原文中的楼层指代。${command.syntax}`;
  return `${action}${args}。${command.syntax}`;
});
export function isEditorIntent(value: { action: string } | undefined): value is EditorIntent {
  return value !== undefined && Object.hasOwn(editorCommands, value.action);
}

export function parseEditorIntent(value: unknown): EditorIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  if (typeof plan.action !== 'string' || !Object.hasOwn(editorCommands, plan.action)) return undefined;
  const action = plan.action as CommandAction;
  const command: Definition = editorCommands[action];
  if (!command.field) return Object.keys(plan).length === 1 ? { action } as EditorIntent : undefined;
  const parameter = plan[command.field];
  if (Object.keys(plan).length !== 2 || typeof parameter !== 'string') return undefined;
  if (command.values === 'level-name') {
    if (!parameter.trim() || parameter.length > 80 || /[\r\n?？]/.test(parameter)) return undefined;
  } else if (command.values === 'element-target') {
    if (parameter !== 'selected' && !(parameter.startsWith('id:') && parameter.length <= 83 && elementIdPattern.test(parameter.slice(3))) &&
        !(parameter.startsWith('table:') && Object.values<string>(deletionTables).includes(parameter.slice(6)))) return undefined;
  } else if (!command.values?.includes(parameter)) return undefined;
  return { action, [command.field]: parameter } as EditorIntent;
}

function commandText(text: string) {
  return normalize(text).replace(/^(?:麻烦(?:你)?|请)(?:帮我|给我)?|^(?:帮我|给我)/, '')
    .replace(/(?:一下|吧)?[。.!！]?$/, '');
}

export function localEditorIntent(text: string): EditorIntent | undefined {
  const request = commandText(text);
  const matched = commands.flatMap(([action, command]) => {
    const argument = command.match(request);
    if (!argument) return [];
    const plan = parseEditorIntent(command.field ? { action, [command.field]: argument } : { action });
    return plan ? [plan] : [];
  });
  return matched.length === 1 ? matched[0] : undefined;
}

/** Only check the floor reference here. The language model interprets the surrounding request. */
export function editorIntentHasGroundedTarget(plan: EditorIntent, text: string): boolean {
  if (plan.action === 'editor.delete') return deletionTarget(commandText(text)) === plan.target;
  if (!('target' in plan)) return true;
  const target = normalize(plan.target);
  if (!target) return false;
  const token = [...target].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const leading = /^[\d零〇一二两三四五六七八九十百千]/.test(target) ? '(?<![a-z0-9_零〇一二两三四五六七八九十百千负-]|地下)'
    : /^[a-z_-]/.test(target) ? '(?<![a-z0-9_-])' : '';
  const trailing = /[a-z0-9_-]$/.test(target) ? '(?![a-z0-9_-])' : '';
  return new RegExp(`${leading}${token}${trailing}`, 'u').test(text.normalize('NFKC').toLowerCase());
}

function levelNumber(text: string) {
  const raw = normalize(text).replace(/^(?:第|f)/, '').replace(/(?:楼|层)$/, '').replaceAll('两', '二');
  if (/^\d+$/.test(raw)) return String(Number(raw));
  const digits = '零一二三四五六七八九';
  if (raw.length === 1 && digits.includes(raw)) return String(digits.indexOf(raw));
  const match = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(raw);
  return match ? String((match[1] ? digits.indexOf(match[1]) : 1) * 10 + (match[2] ? digits.indexOf(match[2]) : 0)) : undefined;
}

export function matchEditorLevel<T extends { id: string; name?: string; number?: string; elevation: number }>(
  levels: readonly T[], currentLevel: string, target: string,
): { level?: T; ambiguous?: true } {
  const name = normalize(target).replace(/^(上|下)一层$/, '$1层');
  if (scope(name) === 'level') return { level: levels.find(level => level.id === currentLevel) };
  if (name === '上层' || name === '下层') {
    const current = levels.find(level => level.id === currentLevel);
    if (!current || !Number.isFinite(current.elevation)) return {};
    const above = name === '上层';
    const candidates = levels.filter(level => Number.isFinite(level.elevation) &&
      (above ? level.elevation > current.elevation : level.elevation < current.elevation))
      .sort((a, b) => above ? a.elevation - b.elevation : b.elevation - a.elevation);
    return candidates.length > 1 && candidates[0].elevation === candidates[1].elevation
      ? { ambiguous: true } : { level: candidates[0] };
  }
  const exact = levels.filter(level => [level.id, level.name].some(value => value && normalize(value) === name));
  if (!exact.length && (name === '底层' || name === '顶层')) {
    const ordered = levels.filter(level => Number.isFinite(level.elevation))
      .sort((a, b) => name === '底层' ? a.elevation - b.elevation : b.elevation - a.elevation);
    return ordered.length > 1 && ordered[0].elevation === ordered[1].elevation
      ? { ambiguous: true } : { level: ordered[0] };
  }
  const number = name === '首层' ? '1' : levelNumber(name);
  const matches = exact.length ? exact : levels.filter(level => level.number !== undefined &&
    (normalize(level.number) === name || (number !== undefined && levelNumber(level.number) === number)));
  return matches.length > 1 ? { ambiguous: true } : { level: matches[0] };
}
