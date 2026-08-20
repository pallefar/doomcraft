/**
 * DOOMCRAFT — shared contract barrel.
 *
 * Client:  import { CHUNK_SIZE } from '@shared/constants.ts'   (vite alias, tree-shakes best)
 *          import { CHUNK_SIZE } from '@shared'                (barrel, also fine)
 * Server:  import { CHUNK_SIZE } from '@doomcraft/shared'
 *
 * Nothing in this package imports three, ws, the DOM or node:*. It runs
 * unchanged on the main thread, in a Worker and in Node.
 */

export * from './constants.ts';
export * from './blocks.ts';
export * from './weapons.ts';
export * from './math.ts';
export * from './protocol.ts';
export * from './terrain.ts';
