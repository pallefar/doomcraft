import { defineConfig } from 'vitest/config';
import path from 'node:path';

const repoRoot = '/Users/karstenhaldan/youtube/doomcraft';
const sharedSrc = path.resolve(repoRoot, 'shared/src');
const clientSrc = path.resolve(repoRoot, 'client/src');

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: [
      { find: /^@shared$/, replacement: path.join(sharedSrc, 'index.ts') },
      { find: /^@shared\//, replacement: sharedSrc + '/' },
      { find: /^@\//, replacement: clientSrc + '/' },
    ],
  },
  test: {
    environment: 'node',
    include: [repoRoot + '/.verify/**/*.vtest.ts'],
    testTimeout: 900000,
    hookTimeout: 900000,
  },
});
