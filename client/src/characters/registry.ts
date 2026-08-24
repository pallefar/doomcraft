/**
 * DOOMCRAFT — who wears what. MOVED, not gone.
 *
 * The look table and the rig constants live in `shared/src/characters.ts` now,
 * because the characters PACK (docs/PACKS.md, PackKind.CHARACTERS) needs its
 * fingerprint recomputable in the server process — a gate check the server
 * cannot run is a gate check that cannot refuse. Everything this module ever
 * exported is re-exported here so no renderer import moved.
 */
export * from '@doomcraft/shared/characters';
