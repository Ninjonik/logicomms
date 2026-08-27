import { useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, KeyRound, LogOut, Mic, Plus, Radio, Settings2, Users } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable } from '@tauri-apps/plugin-autostart';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { callLobbyApi, ensureAnonymousSession, getCurrentUser } from './lib/appwrite';
import { VoiceConnection } from './lib/voice';
import type { VoiceRoute } from './lib/voice';
import { Overlay } from './Overlay';
import './App.css';

type Member = { userId: string; nickname: string; livekitIdentity: string; lastSeenAt: string };
type Lobby = { code: string; ownerId: string; roomName: string; members: Member[] };
type VoiceCredentials = { url: string; room: string; token: string; expiresInSeconds: number };
type Group = { id: string; name: string; key: string; members: string[] };
type Preferences = {
  nickname: string;
  input: string;
  output: string;
  groups: Group[];
  allKey: string;
  replyKey: string;
  launchAtLogin: boolean;
};
type Device = { deviceId: string; label: string };

const initial: Preferences = {
  nickname: '',
  input: 'Default — Microphone',
  output: 'Default — Headphones',
  allKey: 'Y',
  replyKey: 'R',
  launchAtLogin: false,
  groups: [],
};

const loadPreferences = (): Preferences => {
  try {
    const saved = { ...initial, ...JSON.parse(localStorage.getItem('logicomms:preferences') ?? '{}') };
    return {
      ...saved,
      input: saved.input.startsWith('Default') ? 'default' : saved.input,
      output: saved.output.startsWith('Default') ? 'default' : saved.output,
    };
  } catch {
    return initial;
  }
};

function Key({ children, active = false }: { children: string; active?: boolean }) {
  return <kbd className={active ? 'key active' : 'key'}>{children}</kbd>;
}

// The passive Windows hook reports `T`; browsers can report `t` or `KeyT`.
// Store and compare one canonical representation so a logged key event can
// never silently miss a binding because of its spelling.
const normaliseKey = (value: string) => {
  const parts = value.trim().split('+');
  const key = (parts[parts.length - 1] ?? '').replace(/^Key/i, '').replace(/^Digit/i, '');
  return key === ' ' ? 'SPACE' : key.toUpperCase();
};

export default function App() {
  if (window.location.hash === '#overlay') return <Overlay />;
  const [prefs, setPrefs] = useState(loadPreferences);
  const [code, setCode] = useState('');
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [transmitting, setTransmitting] = useState<string[]>([]);
  const [incomingTalkers, setIncomingTalkers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState('Preparing secure session…');
  // VITE_APP_VERSION is injected by the release builder, while getVersion()
  // confirms the native package version at runtime in a Tauri window.
  const [appVersion, setAppVersion] = useState(import.meta.env.VITE_APP_VERSION ?? '0.1.0');
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState('');
  const [voice, setVoice] = useState<VoiceConnection | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ inputs: Device[]; outputs: Device[] }>({ inputs: [], outputs: [] });
  const [capturing, setCapturing] = useState<string | null>(null);
  const voiceRef = useRef<VoiceConnection | null>(null);
  const pressedKeysRef = useRef(new Set<string>());
  const joined = lobby !== null;
  const update = (patch: Partial<Preferences>) => setPrefs((value) => ({ ...value, ...patch }));

  useEffect(() => {
    localStorage.setItem('logicomms:preferences', JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    if (isTauri()) void getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // Check on launch, but let the user explicitly start installation. Starting
  // NSIS while the app is still initializing can otherwise relaunch the app
  // before the replacement has completed.
  useEffect(() => {
    if (!isTauri()) return;
    void check().then(setAvailableUpdate).catch(() => undefined);
  }, []);

  const installUpdate = async () => {
    if (!availableUpdate) return;
    setStatus(`Installing v${availableUpdate.version}…`);
    try {
      await invoke('allow_update_exit');
      await availableUpdate.downloadAndInstall();
    } catch {
      setStatus('Update installation failed');
    }
  };

  const refreshDevices = () =>
      void navigator.mediaDevices
          ?.enumerateDevices()
          .then((entries) =>
              setDevices({
                inputs: entries
                    .filter((entry) => entry.kind === 'audioinput')
                    .map((entry) => ({ deviceId: entry.deviceId, label: entry.label || 'Microphone' })),
                outputs: entries
                    .filter((entry) => entry.kind === 'audiooutput')
                    .map((entry) => ({ deviceId: entry.deviceId, label: entry.label || 'Output device' })),
              }),
          )
          .catch(() => undefined);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, []);

  useEffect(() => {
    void ensureAnonymousSession()
        .then(async () => {
          setUserId((await getCurrentUser()).$id);
          setStatus('Ready');
        })
        .catch((caught) => setStatus(caught.message));
  }, []);

  useEffect(() => {
    if (!lobby) return;
    const connection = new VoiceConnection(setStatus, (identity, active) => {
      const memberId = identity.replace(/^u_/, '');
      setIncomingTalkers((current) => active ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId));
    });
    void callLobbyApi<VoiceCredentials>({ action: 'livekitToken', code: lobby.code })
        .then(async (credentials) => {
          await connection.connect(credentials);
          setVoice(connection);
        })
        .catch((caught) => setStatus(`Voice unavailable: ${caught.message}`));
    return () => {
      setVoice(null);
      setIncomingTalkers([]);
      connection.disconnect();
    };
  }, [lobby?.code]);

  useEffect(() => {
    if (!voice || !lobby || !userId) return;
    const routes: VoiceRoute[] = [
      ...prefs.groups.map((group) => ({ id: group.id, targets: group.members.map((memberId) => `u_${memberId}`) })),
      { id: 'all', targets: lobby.members.filter((member) => member.userId !== userId).map((member) => member.livekitIdentity) },
      { id: 'reply', targets: [] },
    ];
    void voice
        .configure(routes, prefs.input)
        .then(refreshDevices)
        .catch((caught) => setStatus(`Microphone unavailable: ${caught.message}`));
  }, [voice, lobby?.code, prefs.groups, prefs.input, userId]);

  useEffect(() => {
    void voice?.setOutputDevice(prefs.output);
  }, [voice, prefs.output]);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  useEffect(() => {
    if (isTauri()) void (prefs.launchAtLogin ? enable() : disable()).catch(() => undefined);
  }, [prefs.launchAtLogin]);

  useEffect(() => {
    if (!lobby) return;
    const timer = window.setInterval(() => {
      void callLobbyApi<Lobby>({ action: 'heartbeat', code: lobby.code, nickname: prefs.nickname })
          .then(setLobby)
          .catch((caught) => setStatus(caught.message));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [lobby?.code, prefs.nickname]);

  // Push-to-talk key bindings.
  //
  // On Tauri, key events arrive from a passive OS-level listener in Rust
  // (rdev::listen — see src-tauri/src/lib.rs) that observes the global
  // keyboard stream without ever consuming it. That means it fires no
  // matter what has focus — a text field in this app, another app, a
  // fullscreened game — and it never blocks the key from being typed
  // normally wherever it was actually headed. This replaces
  // tauri-plugin-global-shortcut, which grabbed keys exclusively at the OS
  // level and stopped them from reaching any input at all.
  //
  // In a plain browser tab (non-Tauri) there's no way to get global key
  // events, so we fall back to DOM keydown/keyup, which only fires while the
  // window has focus.
  useEffect(() => {
    const bindings = [...prefs.groups, { id: 'all', key: prefs.allKey }, { id: 'reply', key: prefs.replyKey }].filter(
        (binding) => binding.key,
    );

    const change = (key: string, pressed: boolean) => {
      const received = normaliseKey(key);
      if (pressed) {
        if (pressedKeysRef.current.has(received)) return;
        pressedKeysRef.current.add(received);
      } else {
        if (!pressedKeysRef.current.delete(received)) return;
      }
      const ids = bindings.filter((binding) => normaliseKey(binding.key) === received).map((binding) => binding.id);
      ids.forEach((id) => {
        void voiceRef.current?.setTransmitting(id, pressed);
      });
      setTransmitting((current) => (pressed ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id))));
    };

    const down = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName !== 'INPUT' && !event.repeat) change(event.key, true);
    };
    const up = (event: KeyboardEvent) => change(event.key, false);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // Keep DOM events active in Tauri too. The native listener covers other
    // apps; DOM events make the focused WebView reliable on every platform.
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    // Do not gate this on isTauri(). In a packaged WebView that probe can be
    // false during startup even though the native event bridge is available.
    // `listen` rejects in a normal browser, where the DOM fallback is used.
    void Promise.resolve()
        .then(() => listen<{ key: string; pressed: boolean }>('ptt-key', (event) => change(event.payload.key, event.payload.pressed)))
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      pressedKeysRef.current.clear();
    };
  }, [prefs, voice]);

  const create = async () => {
    if (!prefs.nickname.trim()) return setStatus('Choose a nickname first.');
    setBusy(true);
    try {
      setLobby(await callLobbyApi<Lobby>({ action: 'createLobby', nickname: prefs.nickname }));
      setStatus('Connected');
    } catch (caught) {
      setStatus((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!prefs.nickname.trim()) return setStatus('Choose a nickname first.');
    setBusy(true);
    try {
      setLobby(await callLobbyApi<Lobby>({ action: 'joinLobby', code, nickname: prefs.nickname }));
      setStatus('Connected');
    } catch (caught) {
      setStatus((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!lobby) return;
    setBusy(true);
    try {
      await callLobbyApi({ action: 'leaveLobby', code: lobby.code });
      setLobby(null);
      setTransmitting([]);
      setIncomingTalkers([]);
      setStatus('Ready');
    } catch (caught) {
      setStatus((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const targets = useMemo(
      () =>
          transmitting
              .map((id) => (id === 'all' ? 'Everyone' : id === 'reply' ? 'Reply' : prefs.groups.find((group) => group.id === id)?.name))
              .filter(Boolean),
      [transmitting, prefs.groups],
  );

  const outgoingTargets = useMemo(() => {
    const selected = new Set<string>();
    if (!lobby) return selected;
    for (const routeId of transmitting) {
      if (routeId === 'all') lobby.members.filter((member) => member.userId !== userId).forEach((member) => selected.add(member.userId));
      else if (routeId !== 'reply') prefs.groups.find((group) => group.id === routeId)?.members.forEach((memberId) => selected.add(memberId));
    }
    return selected;
  }, [lobby, prefs.groups, transmitting, userId]);

  const outgoingNames = useMemo(
      () => lobby?.members.filter((member) => outgoingTargets.has(member.userId)).map((member) => member.nickname) ?? [],
      [lobby, outgoingTargets],
  );
  const incomingNames = useMemo(
      () => lobby?.members.filter((member) => incomingTalkers.includes(member.userId)).map((member) => member.nickname) ?? [],
      [incomingTalkers, lobby],
  );

  useEffect(() => {
    if (!isTauri()) return;
    const publish = () => void emitTo('overlay', 'overlay-state', {
      people: (lobby?.members ?? []).filter((member) => member.userId !== userId).map((member) => ({ id: member.userId, nickname: member.nickname })),
      outgoing: [...outgoingTargets],
      incoming: incomingTalkers,
    }).catch(() => undefined);
    publish();
    const timer = window.setInterval(publish, 1000);
    return () => window.clearInterval(timer);
  }, [incomingTalkers, lobby, outgoingTargets, userId]);

  const addGroup = (openEditor = false) => {
    const id = crypto.randomUUID();
    update({ groups: [...prefs.groups, { id, name: 'New group', key: '', members: [] }] });
    setCapturing(id);
    if (openEditor) setEditingGroup(id);
  };

  useEffect(() => {
    if (!capturing) return;
    const timer = window.setTimeout(() => document.getElementById(`hotkey-${capturing}`)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [capturing]);

  const toggle = (id: string) =>
      setTransmitting((value) => {
        const active = !value.includes(id);
        void voice?.setTransmitting(id, active);
        return active ? [...value, id] : value.filter((entry) => entry !== id);
      });

  const captureKey = (id: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!capturing) return;
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.code.replace('Key', '').replace('Digit', '');
    if (!key || ['Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key)) return;
    if (id === 'all') update({ allKey: key });
    else if (id === 'reply') update({ replyKey: key });
    else update({ groups: prefs.groups.map((group) => (group.id === id ? { ...group, key } : group)) });
    setCapturing(null);
  };

  return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
          <span className="brand-mark">
            <Radio size={15} />
          </span>
            logicomms
            <span className="app-version">v{appVersion}</span>
          </div>
          {availableUpdate && (
              <button className="update-button" onClick={() => void installUpdate()}>
                Update v{availableUpdate.version}
              </button>
          )}
          <div className={joined ? 'connection connected' : 'connection'}>
            <i />
            {joined ? 'Connected' : status}
          </div>
          <button className="icon-button" aria-label="Settings" onClick={() => setShowSettings((value) => !value)}>
            <Settings2 size={17} />
          </button>
        </header>

        {!joined ? (
            <section className="welcome">
              <h1>Lobby</h1>
              <p>Enter a two-word lobby name, or create one.</p>
              <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="silver-harbor" />
              <button className="primary" disabled={busy} onClick={() => void join()}>
                Join lobby
              </button>
              <button className="quiet" disabled={busy} onClick={() => void create()}>
                Create lobby
              </button>
            </section>
        ) : (
            <>
              <section className="lobby-card">
                <div>
                  <span className="eyebrow">Your lobby</span>
                  <strong>{lobby.code}</strong>
                </div>
                <button className="leave" disabled={busy} onClick={() => void leave()}>
                  <LogOut size={14} /> Leave
                </button>
              </section>

              {targets.length > 0 && (
                  <section className="transmitting">
                    <Mic size={15} />
                    <span>
                Speaking to <b>{targets.join(', ')}</b>
              </span>
                  </section>
              )}
              {(outgoingNames.length > 0 || incomingNames.length > 0) && (
                  <section className="live-activity">
                    {outgoingNames.length > 0 && <span className="outgoing-state">Transmitting to {outgoingNames.join(', ')}</span>}
                    {incomingNames.length > 0 && <span className="incoming-state">Receiving from {incomingNames.join(', ')}</span>}
                  </section>
              )}

              <section className="section">
                <div className="section-title">
              <span>
                <Users size={15} /> People <em>{lobby.members.length}</em>
              </span>
                  <span className="muted">in this lobby</span>
                </div>
                <div className="member-list">
                  {lobby.members.map((member) => (
                      <div
                        className={`member${outgoingTargets.has(member.userId) ? ' outgoing' : ''}${incomingTalkers.includes(member.userId) ? ' incoming' : ''}`}
                        key={member.userId}
                      >
                        <span className="avatar">{member.nickname.slice(0, 1)}</span>
                        <span>{member.nickname}</span>
                        {outgoingTargets.has(member.userId) && <small className="talk-state outgoing-state">You → them</small>}
                        {incomingTalkers.includes(member.userId) && <small className="talk-state incoming-state">Talking to you</small>}
                      </div>
                  ))}
                </div>
              </section>

              <section className="section">
                <div className="section-title">
              <span>
                <KeyRound size={15} /> Your groups
              </span>
                  <button className="text-button" onClick={() => addGroup(true)}>
                    <Plus size={14} /> Group
                  </button>
                </div>
                <div className="group-list">
                  {prefs.groups.map((group) => (
                      <div className="group-wrap" key={group.id}>
                        <div className="group">
                          <button className="group-main" onClick={() => toggle(group.id)}>
                      <span className="group-name">
                        {group.name}
                        <small>{group.members.length} people</small>
                      </span>
                            <Key active={transmitting.includes(group.id)}>{group.key || '—'}</Key>
                          </button>
                          <button className="edit" onClick={() => setEditingGroup(editingGroup === group.id ? null : group.id)}>
                            •••
                          </button>
                        </div>
                        {editingGroup === group.id && (
                            <div className="group-members">
                              <label>
                                Group name
                                <input
                                  value={group.name}
                                  onChange={(event) => update({ groups: prefs.groups.map((entry) => entry.id === group.id ? { ...entry, name: event.target.value } : entry) })}
                                />
                              </label>
                              <button
                                id={`hotkey-${group.id}`}
                                className="binding"
                                onClick={() => setCapturing(group.id)}
                                onKeyDown={(event) => captureKey(group.id, event)}
                              >
                                <span>Hotkey</span>
                                <Key>{capturing === group.id ? 'â€¦' : group.key || 'â€”'}</Key>
                              </button>
                              {lobby.members
                                  .filter((member) => member.userId !== userId)
                                  .map((member) => (
                                      <label key={member.userId}>
                                        <input
                                            type="checkbox"
                                            checked={group.members.includes(member.userId)}
                                            onChange={() =>
                                                update({
                                                  groups: prefs.groups.map((entry) =>
                                                      entry.id === group.id
                                                          ? {
                                                            ...entry,
                                                            members: entry.members.includes(member.userId)
                                                                ? entry.members.filter((id) => id !== member.userId)
                                                                : [...entry.members, member.userId],
                                                          }
                                                          : entry,
                                                  ),
                                                })
                                            }
                                        />
                                        {member.nickname}
                                      </label>
                                  ))}
                            </div>
                        )}
                      </div>
                  ))}
                </div>
              </section>

              <section className="quick-actions">
                <button onClick={() => toggle('all')}>
              <span>
                <Headphones size={15} /> Everyone
              </span>
                  <Key active={transmitting.includes('all')}>{prefs.allKey}</Key>
                </button>
                <button onClick={() => toggle('reply')}>
              <span>
                <Mic size={15} /> Reply
              </span>
                  <Key active={transmitting.includes('reply')}>{prefs.replyKey}</Key>
                </button>
              </section>
            </>
        )}

        {showSettings && (
            <aside className="settings-panel">
              <div className="section-title">
                <span>Settings</span>
                <button className="text-button" onClick={() => setShowSettings(false)}>
                  Done
                </button>
              </div>
              <label>
                Nickname
                <input value={prefs.nickname} maxLength={32} onChange={(event) => update({ nickname: event.target.value })} />
              </label>
              <label>
                Input device
                <select value={prefs.input} onChange={(event) => update({ input: event.target.value })}>
                  <option value="default">System default</option>
                  {devices.inputs.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                  ))}
                </select>
              </label>
              <label>
                Output device
                <select value={prefs.output} onChange={(event) => update({ output: event.target.value })}>
                  <option value="default">System default</option>
                  {devices.outputs.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                  ))}
                </select>
              </label>
              <div className="binding-list">
                <button className="binding" onClick={() => addGroup()}>
                  <span>+ Add group</span>
                  <Key>…</Key>
                </button>
                {[
                  ...prefs.groups,
                  { id: 'all', name: 'Everyone', key: prefs.allKey },
                  { id: 'reply', name: 'Reply', key: prefs.replyKey },
                ].map((binding) => (
                    <button
                        key={binding.id}
                        id={`hotkey-${binding.id}`}
                        className="binding"
                        onClick={() => setCapturing(binding.id)}
                        onKeyDown={(event) => captureKey(binding.id, event)}
                    >
                      <span>{binding.name}</span>
                      <Key>{capturing === binding.id ? '…' : binding.key || '—'}</Key>
                    </button>
                ))}
              </div>
              <label className="toggle">
                <input
                    type="checkbox"
                    checked={prefs.launchAtLogin}
                    onChange={(event) => update({ launchAtLogin: event.target.checked })}
                />{' '}
                Start with Windows
              </label>
            </aside>
        )}
      </main>
  );
}
