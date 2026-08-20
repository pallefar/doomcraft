/**
 * DOOMCRAFT — worldgen (client view).
 *
 * The generator itself moved to `shared/src/terrain.ts` during integration so
 * the server runs the identical code: two descriptions of the level is one too
 * many. This file stays as the client's import site — the offline sandbox, the
 * menu background generator and `world.test.ts` all keep working unchanged.
 */
export * from '@shared/terrain';
