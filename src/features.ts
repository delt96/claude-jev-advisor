export const FEATURES = ['rm'] as const;
export type Feature = (typeof FEATURES)[number];

export type HookSpec = { event: string; matcher?: string; script: string; args: string[] };

export const HOOK_SPECS: Record<Feature, HookSpec[]> = {
  rm: [{ event: 'PreToolUse', matcher: 'Bash', script: 'rm-hook.js', args: [] }],
};

export const SUPPORTED_PLATFORMS: Record<Feature, NodeJS.Platform[] | null> = {
  rm: ['win32'],
};

export const HOOK_TIMEOUT_SECONDS = 15;
export const LEGACY_RM_GUARD = /\/\.claude\/hooks\/rm-guard\/rm-guard\.mjs/;

export function ownScriptPattern(script: string): RegExp {
  return new RegExp(`claude-jev-advisor/dist/${script.replace(/\./g, '\\.')}`);
}

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}
