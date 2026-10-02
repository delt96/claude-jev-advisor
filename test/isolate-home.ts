import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A test that forgets to pass `home` would otherwise edit the real ~/.claude/settings.json through os.homedir().
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jev-advisor-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
