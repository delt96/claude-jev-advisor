import type { Config } from '../config-shape.js';
import { adviceQuestion, type AdviceKind, type BandAdvice } from '../display/line.js';
import { SHORTCUT_ACTION, shortcutLabel } from '../display/shortcut.js';

export type BandElements = { Box: unknown; Text: unknown; Button: unknown };
export type BandInput = { advice: BandAdvice; config: Config; onPress: () => void };

const ICONS: Record<AdviceKind, string> = { compact: '📦', clear: '🧹' };

export function drawBand(ui: BandElements, { advice, config, onPress }: BandInput): unknown {
  const { Box, Text, Button } = ui;
  const head = advice.remainingPct === null ? '🟡' : `🔴 ${advice.remainingPct}% ·`;
  const children: unknown[] = [
    h(Text, null, `${head} ${adviceQuestion(advice.kind, config.lang)} `),
    h(Button, {
      key: `jev-${advice.kind}`,
      label: `${ICONS[advice.kind]} /${advice.kind}`,
      variant: 'primary',
      onPress,
      ...(config.shortcut ? { action: SHORTCUT_ACTION } : {}),
    }),
  ];
  if (config.shortcut) children.push(h(Text, { dimColor: true }, ` ${shortcutLabel(config.shortcut)}`));
  return h(Box, null, ...children);
}
