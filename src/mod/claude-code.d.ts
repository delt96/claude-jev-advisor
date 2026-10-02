// Only the parts of Claude Code's mod API this package uses; Claude Code generates the full API per build into .claude-plugin/types/.
declare module 'claude-code' {
  export type Engine = {
    session: {
      id(): Promise<string>;
      usage(args?: { breakdown?: 'summary' | 'full' }): Promise<{ context: { tokens?: number; window: number; breakdown?: { autoCompactThreshold?: number } } }>;
    };
    fs: { read(path: string): Promise<unknown> };
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): unknown };
    ui: { invalidate(event: 'ui.render'): void };
  };
  export type HookEvent = { props?: Record<string, unknown>; [key: string]: unknown };
  export type Next = (e: HookEvent) => Promise<unknown>;
  export type Hook = ($: Engine, e: HookEvent, next: Next) => unknown;
  export type On = {
    (event: string, hook: Hook): void;
    (event: string, matcher: Record<string, unknown>, hook: Hook): void;
  };
  export type Register = (on: On, options: Readonly<Record<string, unknown>>) => void;
}
