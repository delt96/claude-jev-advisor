import type { Config } from '../config-shape.js';
import { adviceQuestion, formatSize, increaseSuffix, type AdviceKind, type BandAdvice } from '../display/line.js';
import { SHORTCUT_ACTION } from '../display/shortcut.js';

export type BandElements = { Box: unknown; Text: unknown; Button: unknown };
export type BandInput = { advice: BandAdvice; config: Config; onPress: () => void; size: number; increase: number | null };

const ICONS: Record<AdviceKind, string> = { compact: '📦', clear: '🧹' };

export function drawBand(ui: BandElements, { advice, config, onPress, size, increase }: BandInput): unknown {
  const { Box, Text, Button } = ui;
  const k = `${formatSize(size)}${increaseSuffix(increase)}`;
  const head = advice.remainingPct === null ? `🟡 ${k}` : `🔴 ${k} ${advice.remainingPct}%`;
  const controls: unknown[] = [
    h(Button, {
      key: `jev-${advice.kind}`,
      label: `${ICONS[advice.kind]} /${advice.kind}`,
      variant: 'primary',
      autoFocus: true,
      hover: { bold: true },
      onPress,
      ...(config.shortcut ? { action: SHORTCUT_ACTION } : {}),
    }),
  ];
  if (config.shortcut) controls.push(h(Text, { dimColor: true }, config.shortcut));
  return h(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingTop: 1 },
    h(Box, { flexDirection: 'row', gap: 1, minWidth: 0, flexShrink: 1 },
      h(Box, { flexShrink: 0 }, h(Text, { bold: advice.remainingPct !== null }, head)),
      h(Box, { minWidth: 0, flexShrink: 1 },
        h(Text, { wrap: 'truncate-end' }, adviceQuestion(advice.kind, config.lang)),
      ),
    ),
    h(Box, { key: `jev-${advice.kind}-control`, flexDirection: 'row', gap: 1, flexShrink: 0 }, ...controls),
  );
}
