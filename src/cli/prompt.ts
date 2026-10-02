import type { KeyPrompt } from '../key.js';

const ENTER = new Set([10, 13]);
const BACKSPACE = new Set([8, 127]);
const CTRL_C = 3;
const BS = String.fromCharCode(8);

export function terminalPrompt(): KeyPrompt | undefined {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return {
    ask: (question) =>
      new Promise((resolve) => {
        stdout.write(question);
        let value = '';
        const finish = (answer: string) => {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write(String.fromCharCode(10));
          resolve(answer);
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            const code = ch.charCodeAt(0);
            if (ENTER.has(code)) return finish(value);
            if (code === CTRL_C) return finish('');
            if (BACKSPACE.has(code)) {
              if (value) stdout.write(`${BS} ${BS}`);
              value = value.slice(0, -1);
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
      }),
    say: (line) => stdout.write(`${line}${String.fromCharCode(10)}`),
  };
}
