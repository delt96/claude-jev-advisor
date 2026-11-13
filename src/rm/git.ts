import { spawnSync } from 'node:child_process';

export const GIT_TIMEOUT_MS = 3000;
export type GitResult = { status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[], extraEnv?: Record<string, string>) => GitResult;

const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

// check-ignore refuses this setting, so only ls-files and status calls get it.
export const ICASE = { GIT_ICASE_PATHSPECS: '1' };

export const runGit: GitRunner = (args, extraEnv = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: 'C', ...extraEnv };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
