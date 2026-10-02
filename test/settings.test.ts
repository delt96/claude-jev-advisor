import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCommands, hookCommand, withHook, withoutCommands, type Settings } from '../src/settings.js';

const OWN_RM = /claude-jev-advisor\/dist\/rm-hook\.js/;
const LEGACY = /\/\.claude\/hooks\/rm-guard\/rm-guard\.mjs/;
const OUR_COMMAND = 'node "C:/n/@delt/claude-jev-advisor/dist/rm-hook.js"';

test('hookCommand quotes the script with forward slashes and appends arguments', () => {
  assert.equal(
    hookCommand('C:\\Users\\me\\npm\\node_modules\\@delt\\claude-jev-advisor\\dist\\rm-hook.js'),
    'node "C:/Users/me/npm/node_modules/@delt/claude-jev-advisor/dist/rm-hook.js"',
  );
  assert.equal(hookCommand('C:/x/dist/context-hook.js', 'stop'), 'node "C:/x/dist/context-hook.js" stop');
});

test('withHook appends a new group and keeps everything else', () => {
  const before: Settings = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node a.js' }] }] } };
  const after = withHook(before, { event: 'PreToolUse', matcher: 'Bash', command: OUR_COMMAND, timeout: 15 });
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.hooks?.PreToolUse, [
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'node a.js' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: OUR_COMMAND, timeout: 15 }] },
  ]);
  assert.equal(before.hooks?.PreToolUse?.length, 1);
});

test('withHook without a matcher writes no matcher key', () => {
  assert.deepEqual(withHook({}, { event: 'Stop', command: 'node x.js stop', timeout: 15 }), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js stop', timeout: 15 }] }] },
  });
});

test('withoutCommands removes only matching commands and keeps a shared group', () => {
  const before: Settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'node "C:/Users/me/.claude/hooks/rm-guard/rm-guard.mjs"', timeout: 10 },
          { type: 'command', command: 'node my-own-check.js' },
        ],
      }],
    },
  };
  assert.deepEqual(withoutCommands(before, LEGACY), {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-own-check.js' }] }] },
  });
});

test('withoutCommands matches backslash paths and drops emptied groups, events and the hooks key', () => {
  const before: Settings = {
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:\\Users\\me\\.claude\\hooks\\rm-guard\\rm-guard.mjs"' }] }] },
  };
  assert.deepEqual(withoutCommands(before, LEGACY), { model: 'opus' });
});

test('withoutCommands leaves settings without hooks alone', () => {
  assert.deepEqual(withoutCommands({ theme: 'dark' }, OWN_RM), { theme: 'dark' });
});

test('findCommands lists matching commands with their event and matcher', () => {
  const settings = withHook({}, { event: 'PreToolUse', matcher: 'Bash', command: OUR_COMMAND, timeout: 15 });
  assert.deepEqual(findCommands(settings, OWN_RM), [{ event: 'PreToolUse', matcher: 'Bash', command: OUR_COMMAND }]);
  assert.deepEqual(findCommands(settings, LEGACY), []);
});
