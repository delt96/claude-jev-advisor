export const FEATURES = ['rm', 'context'] as const;
export type Feature = (typeof FEATURES)[number];

export type HookSpec = { event: string; matcher?: string; script: string; args: string[] };

export const HOOK_SPECS: Record<Feature, HookSpec[]> = {
  rm: [{ event: 'PreToolUse', matcher: 'Bash|PowerShell', script: 'rm-hook.js', args: [] }],
  context: [
    { event: 'Stop', script: 'context-hook.js', args: ['stop'] },
    { event: 'SessionEnd', script: 'context-hook.js', args: ['session-end'] },
  ],
};

export const SUPPORTED_PLATFORMS: Record<Feature, NodeJS.Platform[] | null> = {
  rm: ['win32'],
  context: null,
};

export const HOOK_TIMEOUT_SECONDS = 15;
export const LEGACY_RM_GUARD = /\/\.claude\/hooks\/rm-guard\/rm-guard\.mjs/;
export const STATUSLINE_SCRIPT = 'statusline.js';
export const MOD_PLUGIN_NAME = 'jev-advisor';
export const MOD_DIR_PATTERN = /claude-jev-advisor\/mod\/?$/;

export function ownScriptPattern(script: string): RegExp {
  return new RegExp(`claude-jev-advisor/dist/${script.replace(/\./g, '\\.')}`);
}

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}
