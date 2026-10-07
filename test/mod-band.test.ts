import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { adviceQuestion, type AdviceKind, type BandAdvice } from '../src/display/line.js';
import { SHORTCUT_ACTION, shortcutLabel } from '../src/display/shortcut.js';
import { drawBand } from '../src/mod/band.js';

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() }),
});

const UI = { Box: 'Box', Text: 'Text', Button: 'Button' };
const KINDS: AdviceKind[] = ['compact', 'clear'];

function nodes(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...node.children.flatMap(nodes)];
}

function words(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (typeof tree !== 'object' || tree === null) return '';
  const node = tree as Node;
  const label = typeof node.props.label === 'string' ? node.props.label : '';
  return label + node.children.map(words).join('');
}

const draw = (advice: BandAdvice, config: Config = DEFAULT_CONFIG, onPress = () => {}) => drawBand(UI, { advice, config, onPress });
const buttons = (tree: unknown) => nodes(tree).filter((n) => n.type === 'Button');

test('the band holds the advice question and one button for the advised command', () => {
  for (const kind of KINDS) {
    const tree = draw({ kind, remainingPct: null });
    const all = buttons(tree);
    assert.equal(all.length, 1);
    assert.ok(String(all[0]?.props.label).includes(`/${kind}`));
    assert.ok(words(tree).includes(adviceQuestion(kind, 'ko')));
  }
  assert.ok(words(draw({ kind: 'clear', remainingPct: null }, { ...DEFAULT_CONFIG, lang: 'en' })).includes('Start fresh?'));
});

test('compact and clear bands differ by more than the question and the command, since one shortcut presses either', () => {
  const rest = (kind: AdviceKind) => words(draw({ kind, remainingPct: null })).replace(adviceQuestion(kind, 'ko'), '').replace(`/${kind}`, '');
  assert.notEqual(rest('compact'), rest('clear'));
});

test('the red zone shows the percent left', () => {
  assert.ok(words(draw({ kind: 'compact', remainingPct: 18 })).includes('18%'));
  assert.equal(words(draw({ kind: 'compact', remainingPct: null })).includes('%'), false);
});

test('the shortcut is bound and shown only when install recorded one', () => {
  const none = draw({ kind: 'compact', remainingPct: null });
  assert.equal(buttons(none)[0]?.props.action, undefined);
  assert.equal(words(none).includes('^X'), false);
  const bound = draw({ kind: 'compact', remainingPct: null }, { ...DEFAULT_CONFIG, shortcut: 'ctrl+x d' });
  assert.equal(buttons(bound)[0]?.props.action, SHORTCUT_ACTION);
  assert.ok(words(bound).includes(shortcutLabel('ctrl+x d')));
});

test('pressing the button runs the handler it was given', () => {
  let pressed = 0;
  const tree = draw({ kind: 'clear', remainingPct: null }, DEFAULT_CONFIG, () => {
    pressed += 1;
  });
  (buttons(tree)[0]?.props.onPress as () => void)();
  assert.equal(pressed, 1);
});

test('no string in the band uses U+FE0F, which terminals draw at the wrong width', () => {
  for (const kind of KINDS) {
    for (const remainingPct of [null, 18]) {
      for (const lang of ['ko', 'en'] as const) {
        assert.equal(words(draw({ kind, remainingPct }, { ...DEFAULT_CONFIG, lang, shortcut: 'ctrl+x d' })).includes('\uFE0F'), false);
      }
    }
  }
});

test('shortcutLabel writes ctrl as a caret', () => {
  assert.equal(shortcutLabel('ctrl+x d'), '^X d');
  assert.equal(shortcutLabel('ctrl+x ctrl+k'), '^X ^K');
});
