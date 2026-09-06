/**
 * DOOMCRAFT — the Loadout tab inside the profile overlay. The DOM half.
 *
 * Every decision was made in `loadoutModel.ts`, which is pure and tested;
 * what is left here is `document.createElement`, three fetches and one POST.
 * The conventions are `accountPanel.ts`'s, verbatim: options carry
 * `{serverBase, deviceId: () => string}`, the fetch wrapper answers
 * `{status: 0}` on a network error rather than throwing, the stylesheet is
 * refcounted under its own prefix (`.dcl-`), and the panel only ever RENDERS
 * an outcome the server already decided.
 *
 * Identity rides `?device=` on GET and `deviceId` in the POST body; when the
 * page is same-origin with the server, the httpOnly `dc_dev` cookie beats
 * both server-side, which is the Safari day-8 fix working as designed.
 */

import {
  buildLoadoutView,
  economyTabsFor,
  wireVariantClaims,
  type EconomyTabId,
  type LoadoutInputs,
  type LoadoutRow,
  type LoadoutSlot,
  type WireInventory,
  type WireItemsPack,
  type WireVariantsPack,
} from '@/ui/loadoutModel';

export interface LoadoutTabOptions {
  /** '' = same origin. */
  serverBase: string;
  deviceId: () => string;
  /** `isEnabled(Feature.ECONOMY)` — the product half of economySurfacesOn. */
  product: () => boolean;
}

/* ------------------------------------------------------------------------ *
 * The menu-time flags probe — one GET per page, shared by the tab strip and
 * every tab (the `ads/serve.ts` pattern; see loadoutModel.economyTabsFor).
 * ------------------------------------------------------------------------ */

let flagsProbe: Promise<Record<string, boolean> | null> | null = null;

export function probeServerFlags(serverBase: string, deviceId: string): Promise<Record<string, boolean> | null> {
  flagsProbe ??= fetch(`${serverBase}/api/flags?device=${encodeURIComponent(deviceId)}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const body = await res.json() as { flags?: Record<string, boolean> };
      return typeof body.flags === 'object' && body.flags !== null ? body.flags : null;
    })
    .catch(() => null);
  return flagsProbe;
}

/** Test seam: the probe is cached for the page; tests need a fresh page. */
export function resetServerFlagsProbe(): void { flagsProbe = null; }

/** Which economy tabs this caller gets, per the probe. */
export async function economyTabs(serverBase: string, deviceId: string): Promise<EconomyTabId[]> {
  return economyTabsFor(await probeServerFlags(serverBase, deviceId));
}

/* ------------------------------------------------------------------------ *
 * Styles — one sheet, refcounted, scoped to `.dcl-`
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-loadout-css';
let styleUsers = 0;

const CSS = `
.dcl{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
.dcl-bal{display:flex;gap:18px;align-items:baseline;border:1px solid rgba(255,255,255,.13);
  border-radius:3px;background:rgba(10,10,14,.86);padding:12px 14px;margin:0 0 11px}
.dcl-bal b{font:800 clamp(18px,3vw,24px)/1 "Arial Black",Impact,sans-serif;color:#f4f1ee;
  font-variant-numeric:tabular-nums}
.dcl-bal em{font:600 10px/1.2 system-ui;font-style:normal;letter-spacing:.18em;
  text-transform:uppercase;color:#8d8781}
.dcl-bal span{font-size:11.5px;color:#7d7873}
.dcl-line{margin:0 0 10px;font-size:12.5px;color:#9d968f}
.dcl-err{margin:0 0 10px;font-size:12px;color:#e8695a;min-height:1.2em}
.dcl-sec{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:12px 14px 6px;margin:0 0 11px}
.dcl-sec h3{margin:0 0 8px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781}
.dcl-row{display:flex;gap:10px;align-items:center;padding:7px 0;
  border-top:1px solid rgba(255,255,255,.06)}
.dcl-row:first-of-type{border-top:0}
.dcl-row i{width:14px;height:14px;border-radius:2px;flex:0 0 14px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 0 2px rgba(255,255,255,.14)}
.dcl-row i.dcl-none{background:rgba(255,255,255,.08)}
.dcl-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:600;color:#e2ddd8}
.dcl-name small{font-weight:400;color:#8d8781;margin-left:6px}
.dcl-meta{flex:0 1 auto;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  color:#9d968f;white-space:nowrap}
.dcl-meta.is-dim{color:#6f6a66}
.dcl-meta.is-bad{color:#e8695a}
.dcl-on{flex:0 0 auto;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:#8fd18a;border:1px solid rgba(143,209,138,.4);border-radius:2px;padding:3px 7px}
.dcl-craft{margin:2px 0 8px 24px;padding:9px 12px;border:1px solid rgba(240,160,32,.35);
  border-radius:3px;background:rgba(240,160,32,.05)}
.dcl-craft p{margin:0 0 7px;font-size:11.5px;color:#cfc9c3}
.dcl-craft .dcl-row{border-top:1px solid rgba(255,255,255,.05)}
.dcl-flash{margin:0 0 10px;padding:8px 12px;border:1px solid rgba(143,209,138,.4);
  border-radius:3px;background:rgba(143,209,138,.06);color:#b9e3b5;font-size:12.5px}
#ui .dcl button{font:700 11px/1 system-ui;letter-spacing:.08em;min-height:30px;
  padding:7px 12px;border:1px solid rgba(255,255,255,.22);border-radius:2px;
  background:rgba(255,255,255,.06);color:#e8e6e3;cursor:pointer;text-transform:uppercase;
  flex:0 0 auto}
#ui .dcl button:hover{border-color:rgba(255,255,255,.4)}
#ui .dcl button:disabled{opacity:.5;cursor:progress}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) === null) {
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ------------------------------------------------------------------------ *
 * The tab
 * ------------------------------------------------------------------------ */

/**
 * `reserved` off the wire, laundered. A NEGATIVE count would *raise* the free
 * copy count above what is owned and re-open exactly the gap V4e closes, so
 * only finite non-negative integers survive.
 */
function laundered(raw: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [ref, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[ref] = Math.floor(v);
  }
  return out;
}

interface ProfileAnswer {
  status: number;
  inventory: WireInventory | null;
  revoked: string[];
  scrap: number;
  lifetimeScrap: number;
  /** V4e — `reserved` off the same answer: ref -> copies the escrow holds. */
  reserved: Record<string, number>;
}

export class LoadoutTab {
  readonly element: HTMLElement;

  private readonly opts: LoadoutTabOptions;
  private destroyed = false;
  private busyRef = '';
  private error = '';
  /** The row whose trade-up picker is expanded, or ''. */
  private craftOpenRef = '';
  /** 'Crafted <name>' after a success; cleared on the next refresh. */
  private flash = '';
  private inputs: LoadoutInputs;
  private pack: WireItemsPack | null = null;
  /** V4f — `/api/variants`; null until it answers, and null if it never does. */
  private variants: WireVariantsPack | null = null;
  private profile: ProfileAnswer | null = null;

  constructor(opts: LoadoutTabOptions) {
    this.opts = opts;
    ensureStyle();
    this.element = el('div', 'dcl');
    this.inputs = this.buildInputs('loading');
    this.paint();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }

  /** Fetch everything fresh and repaint. Called on every switch to this tab. */
  async refresh(): Promise<void> {
    this.error = '';
    this.flash = '';
    this.craftOpenRef = '';
    this.inputs = this.buildInputs('loading');
    this.paint();
    const device = this.opts.deviceId();
    const [profile, pack, variants] = await Promise.all([
      this.fetchProfile(device),
      this.fetchPack(),
      this.fetchVariants(),
      probeServerFlags(this.opts.serverBase, device),
    ]);
    if (this.destroyed) return;
    this.profile = profile;
    this.pack = pack;
    this.variants = variants;
    const phase = profile.status === 200 ? 'ready'
      : profile.status === 404 ? 'noProfile' : 'offline';
    this.inputs = this.buildInputs(phase);
    this.paint();
  }

  /* -------------------------------------------------------------------- */

  private buildInputs(phase: LoadoutInputs['phase']): LoadoutInputs {
    const p = this.profile;
    return {
      phase,
      inventory: p?.inventory ?? null,
      revoked: p?.revoked ?? [],
      scrap: p?.scrap ?? 0,
      lifetimeScrap: p?.lifetimeScrap ?? 0,
      pack: this.pack,
      variants: this.variants,
      reserved: p?.reserved ?? {},
      scrapVisible: this.opts.product() && this.scrapFlagOn,
      busyRef: this.busyRef,
    };
  }

  /** Written by refresh()'s probe result; false until it answers. */
  private scrapFlagOn = false;

  private async fetchProfile(device: string): Promise<ProfileAnswer> {
    try {
      const res = await fetch(`${this.opts.serverBase}/api/profile?device=${encodeURIComponent(device)}`);
      if (res.status === 404) return { status: 404, inventory: null, revoked: [], scrap: 0, lifetimeScrap: 0, reserved: {} };
      if (!res.ok) return { status: 0, inventory: null, revoked: [], scrap: 0, lifetimeScrap: 0, reserved: {} };
      const body = await res.json() as {
        profile?: {
          inventory?: Partial<WireInventory>;
          economy?: { scrap?: number; lifetimeScrap?: number };
          moderation?: { revokedItems?: Array<{ ref?: string }> };
        };
        reserved?: Record<string, unknown>;
      };
      const prof = body.profile;
      const inv = prof?.inventory;
      return {
        status: 200,
        inventory: inv !== undefined && Array.isArray(inv.items)
          ? {
            items: inv.items,
            equippedSkin: String(inv.equippedSkin ?? ''),
            title: String(inv.title ?? ''),
            /* V4f. The decoder DROPPED this field, so `inventory.variants` was
             * `{}` no matter what the profile said and no variant row could
             * ever read as Equipped. `variantClaimsOf` in the model launders
             * the keys and values; this only has to carry it across. */
            variants: wireVariantClaims(inv.variants),
          }
          : { items: [], equippedSkin: '', title: '', variants: {} },
        revoked: (prof?.moderation?.revokedItems ?? [])
          .map((r) => typeof r.ref === 'string' ? r.ref : '')
          .filter((r) => r.length > 0),
        scrap: typeof prof?.economy?.scrap === 'number' ? prof.economy.scrap : 0,
        lifetimeScrap: typeof prof?.economy?.lifetimeScrap === 'number' ? prof.economy.lifetimeScrap : 0,
        reserved: laundered(body.reserved),
      };
    } catch {
      return { status: 0, inventory: null, revoked: [], scrap: 0, lifetimeScrap: 0, reserved: {} };
    }
  }

  /**
   * `GET /api/variants`. A null answer is NOT an empty pack: the model treats
   * null as "cannot name the slot" and offers no equip action, which is the
   * honest thing to do when the fetch failed. An answer of
   * `{version: 0, variants: []}` is the server saying no pack is live.
   */
  private async fetchVariants(): Promise<WireVariantsPack | null> {
    try {
      const res = await fetch(`${this.opts.serverBase}/api/variants`);
      if (!res.ok) return null;
      const body = await res.json() as { version?: number; variants?: WireVariantsPack['variants'] };
      if (!Array.isArray(body.variants)) return null;
      return { version: typeof body.version === 'number' ? body.version : 0, variants: body.variants };
    } catch {
      return null;
    }
  }

  private async fetchPack(): Promise<WireItemsPack | null> {
    try {
      const res = await fetch(`${this.opts.serverBase}/api/items`);
      if (!res.ok) return null;
      const body = await res.json() as { version?: number; items?: WireItemsPack['items'] };
      if (!Array.isArray(body.items)) return null;
      return { version: typeof body.version === 'number' ? body.version : 0, items: body.items };
    } catch {
      return null;
    }
  }

  private async equip(slot: LoadoutSlot, ref: string): Promise<void> {
    if (this.busyRef !== '') return;
    this.busyRef = ref === '' ? 'unequip' : ref;
    this.error = '';
    this.inputs = this.buildInputs('ready');
    this.paint();
    let status = 0;
    let answer: {
      inventory?: { equippedSkin?: string; title?: string; variants?: unknown };
      error?: string;
    } = {};
    try {
      const res = await fetch(`${this.opts.serverBase}/api/equip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.opts.deviceId(), [slot]: ref }),
      });
      status = res.status;
      answer = await res.json().catch(() => ({})) as typeof answer;
    } catch { /* status stays 0 */ }
    if (this.destroyed) return;
    this.busyRef = '';
    if (status === 200 && answer.inventory !== undefined && this.profile?.inventory != null) {
      this.profile.inventory = {
        ...this.profile.inventory,
        equippedSkin: String(answer.inventory.equippedSkin ?? ''),
        title: String(answer.inventory.title ?? ''),
        /* V4f. `POST /api/equip` has answered with the whole claim map since
         * V4c and this reconciliation dropped it, so a successful variant
         * equip repainted from STALE claims: the button flipped back to
         * "Equip" until the next full refresh. */
        variants: wireVariantClaims(answer.inventory.variants),
      };
    } else {
      this.error = status === 0 ? 'No server answered.' : answer.error ?? `Refused (${status}).`;
    }
    this.inputs = this.buildInputs(this.profile?.status === 200 ? 'ready' : 'offline');
    this.paint();
  }

  /**
   * The trade-up: deterministic, the player picked the target, idempotent on
   * a fresh nonce per CLICK (a retry of a failed send would need the same
   * nonce — but a failed send changes nothing server-side, so a new click is
   * a new craft and a new nonce is correct).
   */
  private async craft(sourceRef: string, targetLocalId: string): Promise<void> {
    if (this.busyRef !== '') return;
    this.busyRef = sourceRef;
    this.error = '';
    this.inputs = this.buildInputs('ready');
    this.paint();
    const nonce = crypto.randomUUID().replace(/-/g, '');
    let status = 0;
    let answer: { crafted?: string; error?: string } = {};
    try {
      const res = await fetch(`${this.opts.serverBase}/api/craft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.opts.deviceId(), source: sourceRef, target: targetLocalId, nonce,
        }),
      });
      status = res.status;
      answer = await res.json().catch(() => ({})) as typeof answer;
    } catch { /* status stays 0 */ }
    if (this.destroyed) return;
    this.busyRef = '';
    if (status === 200) {
      await this.refresh(); // the server's inventory is the truth
      if (this.destroyed) return;
      this.flash = 'Crafted. Three copies became one better one — it is in the list below.';
      this.paint();
      return;
    }
    this.error = status === 0 ? 'No server answered.' : answer.error ?? `Refused (${status}).`;
    this.inputs = this.buildInputs('ready');
    this.paint();
  }

  /* -------------------------------------------------------------------- *
   * Painting — no decisions, only placement
   * -------------------------------------------------------------------- */

  private paint(): void {
    // The probe result feeds scrapVisible; adopt it lazily so the first
    // paint (loading) never blocks on the network.
    void probeServerFlags(this.opts.serverBase, this.opts.deviceId()).then((flags) => {
      const on = flags?.economy_scrap === true;
      if (on !== this.scrapFlagOn && !this.destroyed) {
        this.scrapFlagOn = on;
        this.inputs = { ...this.inputs, scrapVisible: this.opts.product() && on };
        this.render();
      }
    });
    this.render();
  }

  private render(): void {
    const v = buildLoadoutView(this.inputs);
    this.element.replaceChildren();

    if (v.balance.shown) {
      const bal = el('div', 'dcl-bal');
      bal.append(
        el('b', undefined, v.balance.scrap),
        el('em', undefined, 'Scrap'),
        el('span', undefined, `${v.balance.lifetime} lifetime — earned in matches, spent on crafting`),
      );
      this.element.appendChild(bal);
    }

    this.element.appendChild(el('p', 'dcl-line', v.line));
    if (this.flash !== '') this.element.appendChild(el('p', 'dcl-flash', this.flash));
    if (this.error !== '') this.element.appendChild(el('p', 'dcl-err', this.error));

    for (const s of v.sections) {
      const sec = el('div', 'dcl-sec');
      sec.appendChild(el('h3', undefined, s.title));
      for (const r of s.rows) {
        sec.appendChild(this.rowEl(r));
        if (this.craftOpenRef === r.ref && r.craftTargets.length > 0) {
          sec.appendChild(this.craftEl(r.ref, r.craftTargets));
        }
      }
      this.element.appendChild(sec);
    }
  }

  private craftEl(sourceRef: string, targets: LoadoutRow['craftTargets']): HTMLElement {
    const box = el('div', 'dcl-craft');
    box.appendChild(el('p', undefined,
      `Trade up: three copies + the Scrap fee become the ONE you pick — no rolls, no boxes.`));
    for (const t of targets) {
      const row = el('div', 'dcl-row');
      const sw = el('i');
      if (t.swatch === '') sw.className = 'dcl-none';
      else sw.style.background = t.swatch;
      row.appendChild(sw);
      const name = el('span', 'dcl-name', t.name);
      name.appendChild(el('small', undefined, t.rarityLabel));
      row.appendChild(name);
      const btn = el('button', undefined, `Craft — ${t.fee} Scrap`);
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        void this.craft(sourceRef, t.localId);
      });
      row.appendChild(btn);
      box.appendChild(row);
    }
    return box;
  }

  private rowEl(r: LoadoutRow): HTMLElement {
    const row = el('div', 'dcl-row');
    const sw = el('i');
    if (r.swatch === '') sw.className = 'dcl-none';
    else sw.style.background = r.swatch;
    row.appendChild(sw);

    const name = el('span', 'dcl-name', r.name);
    if (r.copies > 1) name.appendChild(el('small', undefined, `×${r.copies}`));
    if (r.note !== '' && r.state === 'active') name.appendChild(el('small', undefined, r.note));
    row.appendChild(name);

    const meta = r.state === 'active'
      ? el('span', 'dcl-meta', r.rarityLabel)
      : el('span', r.state === 'revoked' ? 'dcl-meta is-bad' : 'dcl-meta is-dim', r.note);
    row.appendChild(meta);

    if (r.equipped) row.appendChild(el('span', 'dcl-on', 'Equipped'));

    if (r.craftTargets.length > 0) {
      const craft = el('button', undefined, this.craftOpenRef === r.ref ? 'Close' : 'Craft up');
      craft.type = 'button';
      craft.addEventListener('click', (e) => {
        e.preventDefault();
        this.craftOpenRef = this.craftOpenRef === r.ref ? '' : r.ref;
        this.render();
      });
      row.appendChild(craft);
    }

    if (r.action !== null && r.slot !== null) {
      const slot = r.slot;
      const btn = el('button', undefined, r.action === 'equip' ? 'Equip' : 'Unequip');
      btn.type = 'button';
      btn.disabled = r.busy;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        void this.equip(slot, r.action === 'equip' ? r.ref : '');
      });
      row.appendChild(btn);
    }
    return row;
  }
}

export function createLoadoutTab(opts: LoadoutTabOptions): LoadoutTab {
  return new LoadoutTab(opts);
}
