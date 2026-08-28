/**
 * DOOMCRAFT — the share card's client half (S36, docs/ECONOMY.md).
 *
 * `GET /api/share/card` renders the caller's LAST paying round as a 1200×630
 * PNG server-side — the client can neither fake it nor cache it (the route is
 * `private, no-store`; every card is refetched). This module is the button:
 * fetch the bytes, hand them to the system share sheet when the browser has
 * one (`navigator.share` with files), and otherwise download the PNG and put
 * the referral link on the clipboard — the card already bakes the code in.
 *
 * GATING: `share_cards` is decided by the SERVER per caller. Quest and Horde
 * always run in the local Worker, whose session bits can never carry the
 * flag — so every surface here gates on the one-per-page `/api/flags` probe
 * (`probeServerFlags`), exactly like the profile tab strip. A killed flag is
 * false there too, so the kill switch still kills. The static build has no
 * server: the probe answers null and no button ever appears.
 *
 * The mode surfaces (quest intermission, horde run card) cannot be handed
 * options through their hosts without threading them across three layers, so
 * `createMatchShareButton` resolves its own context: the server origin from
 * `resolveServerUrl()` and the device id READ (never minted) from the same
 * localStorage key `main.ts` owns. No server or no id -> null, no button.
 */

import { STORAGE_KEYS } from '@shared/constants';

import { resolveServerUrl } from '@/net/serverConfig';
import { probeServerFlags } from '@/ui/loadoutTab';

/* ------------------------------------------------------------------------ */

/** The device id main.ts minted, or ''. Read-only: a surface never mints. */
export function storedDeviceId(): string {
  try {
    const id = localStorage.getItem(`${STORAGE_KEYS.progress}:device`) ?? '';
    return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

export interface ShareOutcome {
  /** 'shared' | 'downloaded' | 'refused'. */
  readonly kind: 'shared' | 'downloaded' | 'refused';
  /** The sentence to show the player. '' when the sheet took over. */
  readonly note: string;
}

/** Fetch the card and share it. The server's refusal sentences pass through. */
export async function fetchAndShare(serverBase: string, deviceId: string): Promise<ShareOutcome> {
  let res: Response;
  try {
    res = await fetch(`${serverBase}/api/share/card?device=${encodeURIComponent(deviceId)}`);
  } catch {
    return { kind: 'refused', note: 'No server answered.' };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { kind: 'refused', note: body.error ?? `Refused (${res.status}).` };
  }
  const blob = await res.blob();
  const file = new File([blob], 'doomcraft-round.png', { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function'
    && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Doomcraft' });
      return { kind: 'shared', note: '' };
    } catch {
      /* the player closed the sheet — fall through to the download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'doomcraft-round.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 30_000);
  return { kind: 'downloaded', note: 'Card saved — the referral link is printed on it.' };
}

/* ------------------------------------------------------------------------ *
 * The button, self-gating. One element, no stylesheet of its own: callers
 * pass the class of the row they mount it in, so it wears the local look.
 * ------------------------------------------------------------------------ */

export interface MatchShareButton {
  readonly element: HTMLButtonElement;
  dispose(): void;
}

/**
 * A Share button for an end-of-match surface, or null when this build can
 * never share (no server, no device id). Hidden until the probe grants
 * `share_cards`; the probe is cached for the page, so this costs at most one
 * request ever.
 */
export function createMatchShareButton(className: string): MatchShareButton | null {
  const serverBase = resolveServerUrl();
  const deviceId = storedDeviceId();
  if (serverBase === '' || deviceId === '') return null;
  let disposed = false;
  let busy = false;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = 'Share result';
  btn.style.display = 'none';
  void probeServerFlags(serverBase, deviceId).then((flags) => {
    if (!disposed && flags?.share_cards === true) btn.style.display = '';
  });
  btn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    void fetchAndShare(serverBase, deviceId).then((out) => {
      if (disposed) return;
      busy = false;
      btn.disabled = false;
      if (out.note !== '') btn.textContent = out.kind === 'refused' ? out.note.slice(0, 60) : 'Card saved';
      if (out.kind === 'shared') btn.textContent = 'Shared';
    });
  });
  return {
    element: btn,
    dispose(): void { disposed = true; btn.remove(); },
  };
}
