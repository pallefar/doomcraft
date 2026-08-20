import { joinRequestFor, resolveModePlan } from '../server/src/modes.js';
import { ModeId } from '../shared/src/modes.js';
for (const id of [0,1,2,3]) {
  const p = resolveModePlan(joinRequestFor(id as ModeId, id===0?'e1m1-hangar':'', '', 2, 1234));
  console.log(JSON.stringify({key:p.key, botFill:p.botFill, enemyBudget:p.enemyBudget, spawnMs:p.enemySpawnIntervalMs, maxTier:p.enemyMaxTier, runBots:p.runBots, runMonsters:p.runMonsters, runWave:p.runWaveDirector, runPickups:p.runPickups, pvp:p.allowPvp, place:p.allowPlacing, brk:p.allowBreaking, instant:p.instantBreak, maxPlayers:p.maxPlayers, durationMs:p.durationMs, scoreLimit:p.scoreLimit, allWeapons:p.grantAllWeapons, world:p.worldSource, fly:p.creativeFlight}));
}
