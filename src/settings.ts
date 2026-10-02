export type HookCommand = { type: 'command'; command: string; timeout?: number; [key: string]: unknown };
export type HookGroup = { matcher?: string; hooks: HookCommand[]; [key: string]: unknown };
export type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };
export type HookEntry = { event: string; matcher?: string; command: string; timeout: number };

const forwardSlashes = (text: string) => text.replace(/\\/g, '/');

export function hookCommand(scriptPath: string, ...args: string[]): string {
  return [`node "${forwardSlashes(scriptPath)}"`, ...args].join(' ');
}

export function commandMatches(command: string, pattern: RegExp): boolean {
  return pattern.test(forwardSlashes(command));
}

export function withHook(settings: Settings, entry: HookEntry): Settings {
  const group: HookGroup = {
    ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
    hooks: [{ type: 'command', command: entry.command, timeout: entry.timeout }],
  };
  const hooks = { ...(settings.hooks ?? {}) };
  hooks[entry.event] = [...(hooks[entry.event] ?? []), group];
  return { ...settings, hooks };
}

export function withoutCommands(settings: Settings, pattern: RegExp): Settings {
  if (!settings.hooks) return settings;
  const isOurs = (h: HookCommand) => typeof h.command === 'string' && commandMatches(h.command, pattern);
  const hooks: Record<string, HookGroup[]> = {};
  let removedAny = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept: HookGroup[] = [];
    let emptiedByUs = false;
    for (const group of groups) {
      if (!Array.isArray(group.hooks) || !group.hooks.some(isOurs)) {
        kept.push(group);
        continue;
      }
      removedAny = true;
      const remaining = group.hooks.filter((h) => !isOurs(h));
      if (remaining.length) kept.push({ ...group, hooks: remaining });
      else emptiedByUs = true;
    }
    if (kept.length || !emptiedByUs) hooks[event] = kept;
  }
  if (!removedAny) return settings;
  if (!Object.keys(hooks).length) {
    const { hooks: _removed, ...rest } = settings;
    return rest;
  }
  return { ...settings, hooks };
}

export function findCommands(settings: Settings, pattern: RegExp): { event: string; matcher?: string; command: string }[] {
  const found: { event: string; matcher?: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook.command === 'string' && commandMatches(hook.command, pattern)) found.push({ event, matcher: group.matcher, command: hook.command });
      }
    }
  }
  return found;
}
