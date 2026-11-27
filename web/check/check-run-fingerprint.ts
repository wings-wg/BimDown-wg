import type { CheckItem } from './check-import.js';
import { WINDOW_PROTECTION_TOOL } from './conditional-requirement.js';

export async function fingerprint(value: unknown) {
  const text = JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : entry);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export type CheckRunFingerprint = {
  ruleVersion: string;
  executor: string;
  tool?: { id: string; version: number };
  plan: string;
  evidence: string;
  review: string;
};

export function checkRule(item: CheckItem) {
  return item.rule ?? item.clearHeightRule ?? item.doorWidthRule ?? item.overlapRule ?? item.componentMinimumRule ??
    item.dwellingMinimumRule ?? item.conditionalRequirementRule;
}

export async function runFingerprint(item: CheckItem, evidence: string, review: string): Promise<CheckRunFingerprint | undefined> {
  const rule = checkRule(item);
  if (!rule) return undefined;
  const library = item.libraryTool;
  const tool = library ? { id: library.id, version: library.version } : undefined;
  const executor = item.clearHeightRule ? 'clear-height-with-local-exception@1'
    : item.overlapRule ? 'space-overlap@1' : item.doorWidthRule ? 'door-clear-width-by-use@1'
      : item.componentMinimumRule ? 'component-minimum@1'
        : item.dwellingMinimumRule ? 'dwelling-count-minimum@1'
          : item.conditionalRequirementRule ? WINDOW_PROTECTION_TOOL : 'scalar-threshold@1';
  return {
    ruleVersion: rule.version, executor, tool, evidence, review,
    plan: await fingerprint({ rule: { ...rule, reviewed: true }, executor, tool, recipe: library?.recipe }),
  };
}
