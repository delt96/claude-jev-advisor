import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { terminalPrompt } from '../src/cli/prompt.js';

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CTRL_C = String.fromCharCode(3);

function fakeTerminal(tty = true) {
  const raw: boolean[] = [];
  const state = { paused: true };
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: tty,
    setRawMode: (mode: boolean) => raw.push(mode),
    setEncoding: () => undefined,
    resume: () => {
      state.paused = false;
    },
    pause: () => {
      state.paused = true;
    },
  });
  const written: string[] = [];
  const exits: number[] = [];
  const terminal = { stdin, stdout: { isTTY: tty, write: (text: string) => written.push(text) }, exit: (code: number) => exits.push(code) };
  return { terminal, stdin, raw, state, written, exits };
}

test('without a terminal there is no prompt', () => {
  assert.equal(terminalPrompt(fakeTerminal(false).terminal), undefined);
});

test('typed characters are hidden, backspace erases one, Enter answers, and the terminal is restored', async () => {
  const t = fakeTerminal();
  const prompt = terminalPrompt(t.terminal);
  const answer = prompt?.ask('Key: ');
  t.stdin.emit('data', `ts-kx${DEL}ey${CR}`);
  assert.equal(await answer, 'ts-key');
  assert.equal(t.written.join('').includes('ts-'), false);
  assert.deepEqual(t.raw, [true, false]);
  assert.equal(t.state.paused, true);
  assert.equal(t.stdin.listenerCount('data'), 0);
  assert.equal(t.stdin.listenerCount('end'), 0);
});

test('arrow keys are ignored and backspace removes a whole emoji', async () => {
  const t = fakeTerminal();
  const answer = terminalPrompt(t.terminal)?.ask('Key: ');
  t.stdin.emit('data', `${ESC}[A${ESC}[1;5Cab🙂${DEL}${CR}`);
  assert.equal(await answer, 'ab');
});

test('a pasted key with a newline ends at the newline, across chunks', async () => {
  const t = fakeTerminal();
  const answer = terminalPrompt(t.terminal)?.ask('Key: ');
  t.stdin.emit('data', 'ts-');
  t.stdin.emit('data', `key${CR}${LF}junk`);
  assert.equal(await answer, 'ts-key');
});

test('Ctrl+C restores the terminal and exits with 130', () => {
  const t = fakeTerminal();
  void terminalPrompt(t.terminal)?.ask('Key: ');
  t.stdin.emit('data', `ts${CTRL_C}`);
  assert.deepEqual(t.exits, [130]);
  assert.deepEqual(t.raw, [true, false]);
});

test('closed input answers empty', async () => {
  const t = fakeTerminal();
  const answer = terminalPrompt(t.terminal)?.ask('Key: ');
  t.stdin.emit('end');
  assert.equal(await answer, '');
});

test('a second ask after the first works and leaves no listeners behind', async () => {
  const t = fakeTerminal();
  const prompt = terminalPrompt(t.terminal);
  const first = prompt?.ask('Key: ');
  t.stdin.emit('data', `one${CR}`);
  assert.equal(await first, 'one');
  const second = prompt?.ask('Key: ');
  t.stdin.emit('data', `two${CR}`);
  assert.equal(await second, 'two');
  assert.deepEqual(t.raw, [true, false, true, false]);
  assert.equal(t.stdin.listenerCount('data'), 0);
});
