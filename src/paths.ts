import path from 'node:path';

export const claudeDir = (home: string) => path.join(home, '.claude');
export const dataDir = (home: string) => path.join(claudeDir(home), 'claude-jev-advisor');
export const configPath = (home: string) => path.join(dataDir(home), 'config.json');
export const settingsPath = (home: string) => path.join(claudeDir(home), 'settings.json');
export const backupsDir = (home: string) => path.join(claudeDir(home), 'backups');
