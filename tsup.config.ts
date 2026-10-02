import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      cli: 'src/cli.ts',
      'rm-hook': 'src/rm/hook.ts',
      'context-hook': 'src/context/hook.ts',
      statusline: 'src/display/statusline.ts',
    },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    clean: true,
    splitting: false,
    sourcemap: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: { register: 'src/mod/register.ts' },
    outDir: 'mod/hooks',
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    clean: false,
    splitting: false,
    sourcemap: false,
  },
]);
