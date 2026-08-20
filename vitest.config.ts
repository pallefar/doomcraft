/**
 * Root vitest config.
 *
 * `vitest` runs from the repo root, where there is no vite.config.ts, so the
 * `@shared` / `@` aliases that client/vite.config.ts declares are not in scope.
 * This file mirrors exactly those three aliases and nothing else — the test
 * runner must resolve modules the same way the bundler does or a green test
 * proves nothing about the shipped build.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(repoRoot, 'shared/src');
const clientSrc = path.resolve(repoRoot, 'client/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@shared$/, replacement: path.join(sharedSrc, 'index.ts') },
      { find: /^@shared\//, replacement: sharedSrc + '/' },
      { find: /^@\//, replacement: clientSrc + '/' },
    ],
  },
  test: {
    environment: 'node',
    include: ['client/src/**/*.test.ts', 'server/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
  },
});
