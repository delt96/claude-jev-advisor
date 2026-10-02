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
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((h) => !(typeof h.command === 'string' && commandMatches(h.command, pattern))) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _removed, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

export function findCommands(settings: Settings, pattern: RegExp): { event: string; matcher?: string; command: string }[] {
  const found: { event: string; matcher?: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (typeof hook.command === 'string' && commandMatches(hook.command, pattern)) found.push({ event, matcher: group.matcher, command: hook.command });
      }
    }
  }
  return found;
}
