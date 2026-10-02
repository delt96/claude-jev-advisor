import type { KeyPrompt } from '../key.js';

type Listener = (...args: any[]) => void;
type TerminalIn = {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};
type TerminalOut = { isTTY?: boolean; write(text: string): unknown };
export type Terminal = { stdin: TerminalIn; stdout: TerminalOut; exit: (code: number) => void };

const ENTER = new Set([10, 13]);
const BACKSPACE = new Set([8, 127]);
const CTRL_C = 3;
const ESC = 27;
const ERASE = `${String.fromCharCode(8)} ${String.fromCharCode(8)}`;

const PROCESS_TERMINAL: Terminal = { stdin: process.stdin, stdout: process.stdout, exit: (code) => process.exit(code) };

export function terminalPrompt(terminal: Terminal = PROCESS_TERMINAL): KeyPrompt | undefined {
  const { stdin, stdout, exit } = terminal;
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return {
    ask: (question) =>
      new Promise((resolve) => {
        stdout.write(question);
        let value = '';
        let inEscape = false;
        const stop = () => {
          stdin.removeListener('data', onData);
          stdin.removeListener('end', onEnd);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
        };
        const onEnd = () => {
          stop();
          resolve('');
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            const code = ch.charCodeAt(0);
            if (inEscape) {
              if (ch !== '[' && code >= 64 && code <= 126) inEscape = false;
              continue;
            }
            if (code === ESC) {
              inEscape = true;
            } else if (ENTER.has(code)) {
              stop();
              resolve(value);
              return;
            } else if (code === CTRL_C) {
              stop();
              exit(130);
              return;
            } else if (BACKSPACE.has(code)) {
              if (value) stdout.write(ERASE);
              value = Array.from(value).slice(0, -1).join('');
            } else if (code >= 32) {
              value += ch;
              stdout.write('*');
            }
          }
        };
        stdin.setEncoding('utf8');
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
        stdin.on('end', onEnd);
      }),
    say: (line) => {
      stdout.write(`${line}\n`);
    },
  };
}
