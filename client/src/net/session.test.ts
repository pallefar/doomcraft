/**
 * DOOMCRAFT — the local/remote branch, and the promise that offline still works.
 *
 * The live site is static hosting with no server. Everything in session.ts is
 * shaped around that, so these tests are mostly about the NEGATIVE case: what
 * happens when there is no server, when the server is slow, when it is down,
 * when it is draining, and when it dies four seconds after saying hello. Every
 * one of those has to end with a playable match in the Worker and never with a
 * rejected promise or a state the caller has to special-case.
 *
 * `probe`, `makeLocal` and `makeRemote` are all injected, so none of this needs
 * a browser, a socket, or a Worker.
 */

import { describe, expect, it, vi } from 'vitest';
import { ModeId } from '@shared/modes';
import { GameSession, ONLINE_MODES } from './session.js';
import type { ClientTransport } from './transport.js';
import type { LocalServer, LocalServerOptions } from './localServer.js';
import type { ServerHealth } from './matchmaker.js';
import {
  gameSocketUrl,
  normaliseServerUrl,
  toHttpOrigin,
  toWebSocketOrigin,
} from './serverConfig.js';

/* ------------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------------ */

function fakeTransport(tag: string): ClientTransport & { tag: string; closed: boolean } {
  return {
    tag,
    closed: false,
    kind: 'websocket',
    readyState: 1,
    send(): void { /* nothing listens */ },
    close(): void { this.closed = true; },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

interface FakeLocal extends LocalServer { stopped: boolean; options: LocalServerOptions }

function fakeLocalFactory(): { make: (o: LocalServerOptions) => LocalServer; built: FakeLocal[] } {
  const built: FakeLocal[] = [];
  const make = (options: LocalServerOptions): LocalServer => {
    const server = {
      options,
      stopped: false,
      transport: fakeTransport('worker'),
      ready: Promise.resolve(),
      inWorker: true,
      advance(): void { /* manual only */ },
      requestStatus(): void { /* nothing */ },
      stop(): void { server.stopped = true; },
      openPeer(): void { /* p2p only */ },
      receiveFromPeer(): void { /* p2p only */ },
      closePeer(): void { /* p2p only */ },
      resyncPeer(): void { /* p2p only */ },
      onPeerData: null,
      onPeerClosed: null,
    } as unknown as FakeLocal;
    built.push(server);
    return server;
  };
  return { make, built };
}

const HEALTHY: ServerHealth = { ok: true, draining: false, uptimeMs: 1000, rooms: 2, humans: 5 };

interface Harness {
  session: GameSession;
  built: FakeLocal[];
  dialled: string[];
}

function harness(options: {
  serverUrl?: string;
  probe?: () => Promise<ServerHealth | null>;
} = {}): Harness {
  const { make, built } = fakeLocalFactory();
  const dialled: string[] = [];
  const session = new GameSession({
    serverUrl: options.serverUrl ?? 'https://play.example',
    deviceId: 'devicetest01',
    probe: options.probe ?? (async () => HEALTHY),
    makeLocal: make,
    makeRemote: (url) => { dialled.push(url); return fakeTransport('socket'); },
  });
  return { session, built, dialled };
}

/* ------------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------------ */

describe('serverConfig: the default is nowhere', () => {
  it('refuses anything that is not an absolute ws/http origin', () => {
    for (const bad of ['', '   ', '/ws', 'example.com', 'ftp://a.example', 'javascript:alert(1)']) {
      expect(normaliseServerUrl(bad)).toBe('');
    }
  });

  it('treats "off" as an explicit opt-out, so a sticky override can be cleared', () => {
    expect(normaliseServerUrl('off')).toBe('');
    expect(normaliseServerUrl('none')).toBe('');
  });

  it('keeps a path prefix and drops the query, which is ours to write', () => {
    expect(normaliseServerUrl('wss://a.example/game/?x=1#f')).toBe('wss://a.example/game');
    expect(normaliseServerUrl('https://a.example/')).toBe('https://a.example');
  });

  it('maps between the http and ws forms of the same origin', () => {
    expect(toWebSocketOrigin('https://a.example')).toBe('wss://a.example');
    expect(toWebSocketOrigin('http://a.example:8080')).toBe('ws://a.example:8080');
    expect(toHttpOrigin('wss://a.example')).toBe('https://a.example');
    expect(toWebSocketOrigin('wss://a.example')).toBe('wss://a.example');
  });

  it('puts the mode in the socket URL, because that is what routes the room', () => {
    const url = gameSocketUrl('https://a.example', { modeId: ModeId.DEATHMATCH, deviceId: 'abc12345' });
    expect(url).toBe('wss://a.example/ws?mode=deathmatch&device=abc12345');
  });

  it('sends a join code INSTEAD of a mode — a code already names one room', () => {
    const url = gameSocketUrl('https://a.example', { modeId: ModeId.QUEST, code: '9km2qd' });
    expect(url).toBe('wss://a.example/ws?code=9km2qd');
  });

  it('carries the level and skill for Quest and the world for Builder', () => {
    expect(gameSocketUrl('wss://a.example', { modeId: ModeId.QUEST, levelId: 'e1m1-hangar', skill: 4 }))
      .toBe('wss://a.example/ws?mode=quest&level=e1m1-hangar&skill=4');
    expect(gameSocketUrl('wss://a.example', { modeId: ModeId.BUILDER, worldId: 'w1' }))
      .toBe('wss://a.example/ws?mode=builder&world=w1');
  });
});

/* ------------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------------ */

describe('which modes want a server', () => {
  it('never prefers remote when no server is configured', () => {
    const { session } = harness({ serverUrl: '' });
    expect(session.configured).toBe(false);
    for (const modeId of [ModeId.QUEST, ModeId.BUILDER, ModeId.HORDE, ModeId.DEATHMATCH]) {
      expect(session.prefersRemote({ modeId })).toBe(false);
    }
  });

  it('sends Deathmatch to a server and keeps Quest in the Worker', () => {
    const { session } = harness();
    expect(session.prefersRemote({ modeId: ModeId.DEATHMATCH })).toBe(true);
    expect(session.prefersRemote({ modeId: ModeId.QUEST, levelId: 'e1m1-hangar' })).toBe(false);
    expect(ONLINE_MODES.has(ModeId.DEATHMATCH)).toBe(true);
  });

  it('keeps a device-local Builder world local and sends a named one remote', () => {
    const { session } = harness();
    expect(session.prefersRemote({ modeId: ModeId.BUILDER })).toBe(false);
    expect(session.prefersRemote({ modeId: ModeId.BUILDER, worldId: 'shared-world' })).toBe(true);
  });

  it('treats a join code as remote whatever the mode says', () => {
    const { session } = harness();
    expect(session.prefersRemote({ modeId: ModeId.QUEST, code: '9km2qd' })).toBe(true);
  });

  it('honours an explicit force in both directions', () => {
    const { session } = harness();
    expect(session.prefersRemote({ modeId: ModeId.DEATHMATCH, force: 'local' })).toBe(false);
    expect(session.prefersRemote({ modeId: ModeId.QUEST, force: 'remote' })).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Starting a session
 * ------------------------------------------------------------------------ */

describe('offline keeps working', () => {
  it('never probes when there is no server, and comes up local', async () => {
    const probe = vi.fn(async () => HEALTHY);
    const { session, built } = harness({ serverUrl: '', probe });

    const state = await session.start({ modeId: ModeId.DEATHMATCH });
    expect(probe).not.toHaveBeenCalled();
    expect(state.kind).toBe('local');
    expect(state.reason).toBe('no server configured');
    expect(built).toHaveLength(1);
    expect(session.createTransport()).toBe(built[0].transport);
  });

  it('plays locally when the probe says nothing is there — and does not reject', async () => {
    const { session, dialled } = harness({ probe: async () => null });
    const state = await session.start({ modeId: ModeId.DEATHMATCH });
    expect(state.kind).toBe('local');
    expect(state.fellBack).toBe(true);
    expect(state.reason).toContain('offline');
    expect(dialled).toEqual([]);
  });

  it('plays locally when the probe itself throws', async () => {
    const { session } = harness({ probe: async () => { throw new Error('DNS'); } });
    await expect(session.start({ modeId: ModeId.DEATHMATCH })).resolves.toMatchObject({ kind: 'local' });
  });

  it('turns auto-reconnect off for a local session and on for a remote one', async () => {
    const { session } = harness();
    await session.start({ modeId: ModeId.QUEST });
    expect(session.wantsAutoReconnect).toBe(false);
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(session.wantsAutoReconnect).toBe(true);
  });
});

describe('going remote', () => {
  it('dials the routed socket URL, not a bare /ws', async () => {
    const { session, dialled, built } = harness();
    const state = await session.start({ modeId: ModeId.DEATHMATCH });

    expect(state.kind).toBe('remote');
    expect(state.reason).toBe('5 online');
    expect(built).toHaveLength(0);
    session.createTransport();
    expect(dialled).toEqual(['wss://play.example/ws?mode=deathmatch&device=devicetest01']);
  });

  it('carries a join code through to the socket', async () => {
    const { session, dialled } = harness();
    await session.start({ modeId: ModeId.DEATHMATCH, code: '9km2qd' });
    session.createTransport();
    expect(dialled[0]).toBe('wss://play.example/ws?code=9km2qd&device=devicetest01');
  });

  it('refuses a draining host — probeServer answers null for one', async () => {
    // `probeServer` already turns draining into null; this pins the contract
    // the session depends on rather than re-implementing it here.
    const { session } = harness({ probe: async () => null });
    expect((await session.start({ modeId: ModeId.DEATHMATCH })).kind).toBe('local');
  });

  it('reuses one health answer across matches instead of probing every time', async () => {
    const probe = vi.fn(async () => HEALTHY);
    const { session } = harness({ probe });
    await session.start({ modeId: ModeId.DEATHMATCH });
    await session.start({ modeId: ModeId.DEATHMATCH });
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('collapses two overlapping probes into one request', async () => {
    let resolveProbe: (v: ServerHealth | null) => void = () => { /* replaced */ };
    const probe = vi.fn(() => new Promise<ServerHealth | null>((r) => { resolveProbe = r; }));
    const { session } = harness({ probe });

    const a = session.start({ modeId: ModeId.DEATHMATCH });
    const b = session.start({ modeId: ModeId.DEATHMATCH });
    resolveProbe(HEALTHY);
    await Promise.all([a, b]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Falling back
 * ------------------------------------------------------------------------ */

describe('a remote session that fails falls back, once', () => {
  it('brings the Worker room up and reports why', async () => {
    const states: string[] = [];
    const { make, built } = fakeLocalFactory();
    const session = new GameSession({
      serverUrl: 'https://play.example',
      probe: async () => HEALTHY,
      makeLocal: make,
      makeRemote: () => fakeTransport('socket'),
      onState: (s) => { states.push(`${s.kind}:${s.reason}`); },
    });

    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(session.kind).toBe('remote');

    expect(session.fallBackToLocal('server closed the connection')).toBe(true);
    expect(session.kind).toBe('local');
    expect(session.current.fellBack).toBe(true);
    expect(built).toHaveLength(1);
    expect(states).toEqual(['remote:5 online', 'local:server closed the connection']);
  });

  it('refuses a second fallback, so a flapping server cannot loop the player', async () => {
    const { session } = harness();
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(session.fallBackToLocal('first')).toBe(true);
    expect(session.fallBackToLocal('second')).toBe(false);
    expect(session.current.reason).toBe('first');
  });

  it('does nothing when the session is already local', async () => {
    const { session } = harness();
    await session.start({ modeId: ModeId.QUEST });
    expect(session.fallBackToLocal('pointless')).toBe(false);
  });

  it('re-probes on the next match rather than trusting the stale "it is up"', async () => {
    const probe = vi.fn(async () => HEALTHY);
    const { session } = harness({ probe });
    await session.start({ modeId: ModeId.DEATHMATCH });
    session.fallBackToLocal('it died');
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh fallback for a NEW match after one was spent', async () => {
    const { session } = harness();
    await session.start({ modeId: ModeId.DEATHMATCH });
    session.fallBackToLocal('died once');
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(session.kind).toBe('remote');
    expect(session.fallBackToLocal('died again')).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

describe('one room at a time', () => {
  it('stops the old Worker room before building the next one', async () => {
    const { session, built } = harness({ serverUrl: '' });
    await session.start({ modeId: ModeId.QUEST });
    await session.start({ modeId: ModeId.HORDE });
    expect(built).toHaveLength(2);
    expect(built[0].stopped).toBe(true);
    expect(built[1].stopped).toBe(false);
  });

  it('stops the Worker room when it goes remote', async () => {
    const { session, built } = harness();
    await session.start({ modeId: ModeId.QUEST });
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(built[0].stopped).toBe(true);
    expect(session.localServer).toBeNull();
  });

  it('drops a probe answer that arrives after a newer start() overtook it', async () => {
    let resolveSlow: (v: ServerHealth | null) => void = () => { /* replaced */ };
    let call = 0;
    const { make, built } = fakeLocalFactory();
    const session = new GameSession({
      serverUrl: 'https://play.example',
      probe: () => {
        call++;
        if (call === 1) return new Promise<ServerHealth | null>((r) => { resolveSlow = r; });
        return Promise.resolve(HEALTHY);
      },
      makeLocal: make,
      makeRemote: () => fakeTransport('socket'),
    });

    const slow = session.start({ modeId: ModeId.DEATHMATCH });
    // The player changed their mind and picked Quest before the probe answered.
    await session.start({ modeId: ModeId.QUEST });
    resolveSlow(HEALTHY);
    await slow;

    expect(session.kind).toBe('local');
    expect(built.filter((b) => !b.stopped)).toHaveLength(1);
  });

  it('stops the room and answers nothing more once disposed', async () => {
    const { session, built } = harness({ serverUrl: '' });
    await session.start({ modeId: ModeId.QUEST });
    session.dispose();
    expect(built[0].stopped).toBe(true);
    await session.start({ modeId: ModeId.DEATHMATCH });
    expect(built).toHaveLength(1);
  });
});
