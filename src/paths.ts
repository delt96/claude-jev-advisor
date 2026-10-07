import path from 'node:path';

export const claudeDir = (home: string) => path.join(home, '.claude');
export const dataDir = (home: string) => path.join(claudeDir(home), 'claude-jev-advisor');
export const configPath = (home: string) => path.join(dataDir(home), 'config.json');
export const settingsPath = (home: string) => path.join(claudeDir(home), 'settings.json');
export const keybindingsPath = (home: string) => path.join(claudeDir(home), 'keybindings.json');
export const backupsDir = (home: string) => path.join(claudeDir(home), 'backups');
export const stateDir = (home: string) => path.join(dataDir(home), 'state');
export const logDir = (home: string) => path.join(dataDir(home), 'log');
export const statusLineBeforePath = (home: string) => path.join(dataDir(home), 'statusline-before.json');
export const savedKeyPath = (home: string) => path.join(dataDir(home), 'jev-key.env');
