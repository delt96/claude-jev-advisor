import { spawnSync } from 'node:child_process';

export const GIT_TIMEOUT_MS = 3000;
export type GitResult = { status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[], extraEnv?: Record<string, string>) => GitResult;

const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

// check-ignore refuses this setting, so only ls-files and status calls get it.
export const ICASE = { GIT_ICASE_PATHSPECS: '1' };

// Without GIT_OPTIONAL_LOCKS=0 status refreshes the index under .git/index.lock and can break a git command the user runs meanwhile.
export function gitEnv(extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...extraEnv };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  return env;
}

export const runGit: GitRunner = (args, extraEnv = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: gitEnv(extraEnv) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
