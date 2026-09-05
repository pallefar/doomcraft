# V4 surface map (Explore agent, 2026-09-05, verified file:line)

## Variant pack format & discovery
- `parseVariantsManifest(text)` — shared/src/variants.ts:373. Root `{ variants: [...] }`,
  <= 64 entries (MAX_VARIANTS_PER_PACK, :104). Extra root keys ignored.
- Per-variant keys, all four required: `id` (=== sanitiseContentId, modes.ts:654,
  lowercase [a-z0-9][a-z0-9_-]{0,47}), `base` (integer WeaponId, a NUMBER not a name),
  `name` (non-empty, truncated at MAX_VARIANT_NAME=40, :106), `over` (object,
  whitelist-only keys via Object.hasOwn, :436; unknown key = REFUSAL; finite;
  integral where band.integer; not inert; inside band). Empty `over` refused (:480).
- Whole-variant gates: payload band damage*pellets in 0.25..2.5x (:491), budget +/-12%
  (:503), strict dominance (:512). Any error => manifest: null for the WHOLE file (:524).
- A working fixture already exists: server/src/releases.test.ts:43-51.

## The release:verify GAP V4 must close
- items: DEFAULT_ITEMS_FILE at server/src/gate.ts:68, read unconditionally at :521,
  EMITTED as a pack at :579-583.
- variants: read ONLY if options.variantsFile is passed (gate.ts:526, VerifyOptions:486),
  and **there is no variantsPack push in runReleaseVerify at all**.
  tools/release-verify.mjs:41 calls runReleaseVerify() with NO options.
- PackInventory.variantsFileFor (packs.ts:208) is packsRoot-only, no content/ fallback
  (deliberate, :196-207). variantsVersions at :216, variantsAt at :230.
- => V4 needs DEFAULT_VARIANTS_FILE, a default read, a variantsPack push, and a
  content/variants.json fallback branch in variantsFileFor + variantsVersions.

## RoomOptions.variantClaims — the missing link
- Declared server/src/room.ts:205 `variantClaims?: (conn: Connection) => Uint8Array`.
  Field :359, assigned :488, consumed ONCE in Room.onHello :1197 via
  resolveVariantSlots(..., caps, arsenal.slotCount) -> sim.addPlayer, BEFORE the body
  exists (spawnPlayer sizes the first magazine, sim.ts:839-840, :881).
- Production factory `new Room({...})` at server/src/index.ts:1030 passes `variants`
  (:1054) but NEVER `variantClaims` => undefined => all-zeros for every real player.
  Only two call sites supply it and both are tests (patch.test.ts:431,
  client/src/net/variantWire.test.ts:83).
- Chain: POST /api/equip (index.ts:3101-3147, equipVerdict/applyEquip
  persistence.ts:1082/:1105) -> graph.mintDeviceTicket (accountGraph.ts:503) carrying
  profileKey -> WS upgrade redeems (index.ts:4116), conn.deviceId = ticket.profileKey
  (:4128) -> Room.onHello (:1182).
- **THE BLOCKER: variantClaims is SYNCHRONOUS and every PersistenceStore read is a
  Promise** (persistence.ts:364-384, JsonFileStore.load :1633). JsonFileStore has a
  private cache Map (:1529) with no sync accessor. V4 must either prefetch the profile
  at ticket-redeem time (index.ts:4116, already async, before room.join at :4125) into a
  map the closure reads, or add a sync peek(deviceId).
- Precedent for pinning the factory line: server/src/releases.test.ts:702-707 reads
  index.ts as SOURCE TEXT and asserts new Room(...) still names `variants`.

## ItemKind + WEAPON_VARIANT
- Declared shared/src/items.ts:26-32 (SKIN 0, EMBLEM 1, TRAIL 2, TITLE 3, TROPHY 4);
  ITEM_KIND_NAMES :34 (order load-bearing — guessKind indexes it).
- Sites: ITEM_KIND_NAMES :34, KIND_BY_NAME :123-126, tradability :186-189, title-text
  :191-194, ItemDef :46-64 (**no field carries a link to a variant content id today** —
  reuse `text` or add a field; adding one re-fingerprints EVERY items line).
- itemsFingerprintInputs shared/src/items.ts:208-216, 160-byte cap packs.ts:137.
- Profile: StoredInventory persistence.ts:206-211 (items/equippedSkin/title — a variant
  claim needs a THIRD slot), defaultInventory :444, migration :544, sanitiseInventory
  :747-754, EquipSlot :1067, KIND_FOR_SLOT :1069-1072, equipVerdict :1082, applyEquip :1105.
- Trading: server/src/trades.ts:225/:197/:102; client/src/ui/tradeModel.ts:238 hard-codes
  TITLE||TROPHY as untradable.
- Drops: rollMatchDrops server/src/packs.ts:1219-1245, kind exclusion :1229.
- Crafting (ITEM craft, not block): CRAFTABLE_KINDS server/src/craft.ts:53-55, client
  restatement client/src/ui/loadoutModel.ts:221 (drift-guarded by loadoutModel.test.ts).
- Client loadout: KIND_ORDER/SECTION_TITLES/SLOT_FOR_KIND loadoutModel.ts:189-207 (all
  five enumerated; a sixth silently renders nothing); guessKind :324-328 splits the id on
  '-' and indexes ITEM_KIND_NAMES — 'weapon_variant' cannot survive that split.
- Admin: console.ts:358 and :769 enumerate the five kinds verbatim; swatch renderer
  :1899-1916; admin/model.ts:263-275; studio.ts:123-148.

## Equip path (the template)
- Client: loadoutTab.ts button :438-444, POST /api/equip in LoadoutTab.equip :260-291
  with {deviceId, [slot]: ref}. Decisions live in the pure model loadoutModel.ts
  (SLOT_FOR_KIND :201-207, row action :281-286, never offered on a non-ACTIVE item :285).
- Route: server/src/index.ts:3101-3148 — identity :3104, kill switch economy_items :3107,
  slot loop over ['skin','title'] :3111, kindOf resolves ref through live then granting
  pack :3122, validate-then-write in ONE store.update so a refusal writes no slot :3134,
  response echoes {inventory:{equippedSkin,title}} :3143.
- **The cosmetic equip has NO in-room leg to copy.** equippedSkin appears nowhere in
  room.ts/net.ts/sim.ts; the HELLO `skin` byte (client/src/net/client.ts:1275,
  net.ts:323) is an appearance index, not an item ref. V4 is the first equip that
  crosses into a room, and variantClaims is its seam.

## Killfeed
- S2C.KILL = 6 protocol.ts:82. KillEvent :1153-1159 {killerId, victimId, weaponId, flags,
  killerStreak}. encodeKill :1164-1174 = u8 op, u16, u16, u8 weaponId, u8 flags, u8 streak
  = 8 bytes. decodeKill :1176. Flags :240-243. **No variant field.**
- Server emit server/src/net.ts:964-971; events built server/src/sim.ts:1523-1529.
- Client: client.ts:1555/:1796; game.ts:1308 `getWeapon(e.weaponId).name`;
  ALSO client/src/modes/deathmatch/killfeed.ts:379 weaponName(e.weaponId) + glyph :374.
- protocol.ts:151-155 states the VARIANT_TABLE layout is FROZEN and a display name must
  be a SEPARATE additive message.

## Display readers (client/src/game/weapons.ts)
- maxBurstDamage :1441-1444 — `getWeapon(id).damage * .pellets`, MODULE table. Ignores slot.
- currentAmmoType :1447-1449 — WEAPON_AMMO[runtime.current], module hot table (ammo is not
  variant-able, so arguably correct, but inconsistent).
- headshotScale :1452-1454 — getWeapon(id).headshotMultiplier * (HEADSHOT_MULTIPLIER/2).
  headshotMultiplier IS whitelisted (variants.ts:76) => wrong for any equipped hitscan variant.
- The correct source already exists: WeaponRuntime.stats(weaponId) :519-521 =
  arsenal.statsFor(id, this.variantSlots[id] ?? BASE_SLOT); slots adopted :576-580, wired
  from the wire at game.ts:717.

## Admin console pack summary
- PackInventory.summary() server/src/packs.ts:417-470; return type :417-422 has
  levels/campaign/items/quests and NO variants; the items/quests pair is :450-467 and the
  return is :469. Plumbing (variantsVersions :216, variantsAt :230) already exists.
- Consumers: paintInventory console.ts:1454-1494 (levels + campaign only — items and
  quests are not painted either); expansion-draft selects markup :432-435 and fill
  :1754-1757; body read :1780-1787 (**no body.variants line**, even though the server
  already accepts it at index.ts:3254 / packs.ts:748).
- Feeders: GET /api/admin/studio index.ts:2732; also index.ts:3222.
- server/src/studio.ts has NO variants save path (items :123-148, quests :237-288).

## Crafting
- shared/src/crafting.ts is BLOCK crafting (CraftRecipe :25-31 out: BlockId). A variant
  token cannot use it — recipeTableErrors :82 asserts BF_PLACEABLE.
- The ITEM craft engine is server/src/craft.ts: craftVerdict :76, CRAFT_COPIES = 3 :41,
  CRAFT_FEES by target rarity :44-50, CRAFTABLE_KINDS :53-55; route POST /api/craft
  index.ts:3155+. It crafts SAME KIND, ONE RARITY UP — so it can only make a variant
  token from three variant tokens, not from cosmetics.

## Tests to model on
- Items parse/release: shared/src/items.test.ts (:105-110 swap test); server/src/gate.test.ts
  (check list :295 already has 'variants.validate'; tree-side suite :430-465; runReleaseVerify
  over the shipped tree :286-306); server/src/releases.test.ts (VARIANTS_JSON :43-51,
  installVariants :53, packsRoot :58-71, stageOne :81-93, installedPacks label :106-108);
  shared/src/packs.test.ts; server/src/inventory.test.ts (:121, :158-165); studio.test.ts.
- Equip route: server/src/equipRoutes.test.ts (:119 kill switch, :137 both slots, :144
  mixed writes neither, :155 kind mismatch, :161 revoked, :167 unknown pack, :173 '' unequips).
- **Closest model for V4**: client/src/net/variantWire.test.ts — a real Room with
  variantClaims (:75-85), a real NetClient over a pumped Link (:43-70), field-for-field
  server/client stats comparison incl. hot (:128-140), first-magazine assertion (:146-148).
- Two-browser: tools/online-verify.mjs (two contexts Alpha/Bravo :175-186, same remote
  room :194-208, /api/rooms confirmation :206, cross-browser body movement :229+).
  tools/shot-loadout.mjs is single-browser but is the equip read-back template
  (seeds a profile :60-80, drives the real Loadout tab, reads /api/profile back :132-141).
- V3 golden: shared/src/version.test.ts:287 'golden wire vectors', :327-360
  'VARIANT_TABLE encodes to the frozen bytes' (143-byte hex literal :346-353).
  shared/src/variants.test.ts: room table on the wire :442, bands :174, budget :225,
  dominance :306, fingerprint :379 incl. the 160-byte cap test :401.
