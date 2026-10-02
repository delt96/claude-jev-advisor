import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jev-advisor-test-'));
process.env.TEMP = root;
process.env.TMP = root;
process.env.TMPDIR = root;

// A test that forgets to pass `home` would otherwise edit the real ~/.claude/settings.json through os.homedir().
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});
