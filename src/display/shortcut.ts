export const SHORTCUT_CHORD = 'ctrl+x d';
// Claude Code lets a mod Button take the chord of an engine action whose own handler is not mounted;
// diff:back has no key of its own and is handled only while the diff dialog is open.
export const SHORTCUT_ACTION = 'diff:back';
export const SHORTCUT_CONTEXT = 'DiffDialog';

export function shortcutLabel(chord: string): string {
  return chord
    .split(' ')
    .map((stroke) => stroke.replace(/^ctrl\+(.)$/, (_match, key: string) => `^${key.toUpperCase()}`))
    .join(' ');
}
