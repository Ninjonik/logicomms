import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Headphones, KeyRound, LogOut, Mic, Plus, Radio, Settings2, Users } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable } from '@tauri-apps/plugin-autostart';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { LogicalPosition, LogicalSize, currentMonitor } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { callLobbyApi, ensureAnonymousSession, getCurrentUser, subscribeToLobby } from './lib/appwrite';
import { VoiceConnection } from './lib/voice';
import type { VoiceRoute } from './lib/voice';
import { Overlay } from './Overlay';
import './App.css';

type Member = { userId: string; nickname: string; livekitIdentity: string; lastSeenAt: string };
type Lobby = { code: string; ownerId: string; roomName: string; members: Member[] };
type VoiceCredentials = { url: string; room: string; token: string; expiresInSeconds: number };
type Group = { id: string; name: string; key: string; members: string[] };
// Groups are deliberately local preferences.  Keep a tiny address book beside
// them so a member can still be edited after they have left the lobby.
type KnownPerson = { userId: string; nickname: string };
type Language = 'en' | 'cs';
type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type Preferences = {
  nickname: string;
  input: string;
  output: string;
  inputVolume: number;
  outputVolume: number;
  groups: Group[];
  people: KnownPerson[];
  allKey: string;
  replyKey: string;
  launchAtLogin: boolean;
  autoUpdate: boolean;
  overlayPosition: OverlayPosition;
  overlayScale: number;
  language?: Language;
  lastLobbyCode?: string;
};
type Device = { deviceId: string; label: string };

const initial: Preferences = {
  nickname: '',
  input: 'Default — Microphone',
  output: 'Default — Headphones',
  inputVolume: 100,
  outputVolume: 100,
  allKey: 'Y',
  replyKey: 'R',
  launchAtLogin: false,
  autoUpdate: true,
  overlayPosition: 'top-left',
  overlayScale: 100,
  groups: [],
  people: [],
};

const translations = {
  en: { language: 'Language', chooseLanguage: 'Choose your language', languageHint: 'You can change this later in Settings.', english: 'English', czech: 'Čeština', settings: 'Settings', done: 'Done', people: 'People', inLobby: 'in this lobby', yourGroups: 'Your groups', group: 'Group', groupName: 'Group name', hotkey: 'Hotkey', assignPeople: 'Assign people', addGroup: 'Add group', waiting: 'Press a key to assign it', cancel: 'Cancel', savedLocally: 'Saved locally — connected people appear first', savedPerson: 'Saved person', inThisLobby: 'In this lobby', add: 'Add', added: 'Added', noPeople: 'People you meet in a lobby will stay available here.', languageSetting: 'Language', inputDevice: 'Input device', outputDevice: 'Output device', startWindows: 'Start with Windows', autoUpdates: 'Automatically check for updates on launch', overlayPosition: 'Overlay position', overlaySize: 'Overlay size', everyone: 'Everyone', reply: 'Reply', leave: 'Leave', lobby: 'Lobby', lobbyCode: 'Lobby code', joinLobby: 'Join lobby', createLobby: 'Create lobby', nickname: 'Nickname', yourNickname: 'Your nickname', customLobby: 'Custom lobby name', optional: 'optional', connected: 'Connected', assign: 'Assign people' },
  cs: { language: 'Jazyk', chooseLanguage: 'Vyberte jazyk', languageHint: 'Později ho můžete změnit v Nastavení.', english: 'English', czech: 'Čeština', settings: 'Nastavení', done: 'Hotovo', people: 'Lidé', inLobby: 'v této místnosti', yourGroups: 'Vaše skupiny', group: 'Skupina', groupName: 'Název skupiny', hotkey: 'Klávesová zkratka', assignPeople: 'Přiřadit lidi', addGroup: 'Přidat skupinu', waiting: 'Stiskněte klávesu pro přiřazení', cancel: 'Zrušit', savedLocally: 'Uloženo místně — připojení lidé jsou první', savedPerson: 'Uložený člověk', inThisLobby: 'V této místnosti', add: 'Přidat', added: 'Přidáno', noPeople: 'Lidé, které potkáte v místnosti, zde zůstanou k dispozici.', languageSetting: 'Jazyk', inputDevice: 'Vstupní zařízení', outputDevice: 'Výstupní zařízení', startWindows: 'Spustit se systémem Windows', autoUpdates: 'Automaticky hledat aktualizace při spuštění', overlayPosition: 'Pozice překryvu', overlaySize: 'Velikost překryvu', everyone: 'Všichni', reply: 'Odpovědět', leave: 'Odejít', lobby: 'Místnost', lobbyCode: 'Kód místnosti', joinLobby: 'Připojit se', createLobby: 'Vytvořit místnost', nickname: 'Přezdívka', yourNickname: 'Vaše přezdívka', customLobby: 'Vlastní název místnosti', optional: 'nepovinné', connected: 'Připojeno', assign: 'Přiřadit lidi' },
} as const;

const loadPreferences = (): Preferences => {
  try {
    const saved = { ...initial, ...JSON.parse(localStorage.getItem('logicomms:preferences') ?? '{}') };
    return {
      ...saved,
      people: Array.isArray(saved.people) ? saved.people : [],
      inputVolume: typeof saved.inputVolume === 'number' ? saved.inputVolume : 100,
      outputVolume: typeof saved.outputVolume === 'number' ? saved.outputVolume : 100,
      input: saved.input.startsWith('Default') ? 'default' : saved.input,
      output: saved.output.startsWith('Default') ? 'default' : saved.output,
    };
  } catch {
    return initial;
  }
};

const displayKey = (value: string) => value
    .replace(/\u00e2\u20ac\u00a6/g, '...')
    .replace(/\u00e2\u20ac\u201d/g, '-')
    .replace(/\u00e2\u20ac\u201c/g, '-')
    .replace(/\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u00a6/g, '...')
    .replace(/\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u201d/g, '-');

function Key({ children, active = false }: { children: string; active?: boolean }) {
  return <kbd className={active ? 'key active' : 'key'}>{displayKey(children)}</kbd>;
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
  const [newLobbyCode, setNewLobbyCode] = useState('');
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [transmitting, setTransmitting] = useState<string[]>([]);
  const [incomingTalkers, setIncomingTalkers] = useState<string[]>([]);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState('Preparing secure session…');
  const [microphoneMessage, setMicrophoneMessage] = useState<string | null>(null);
  // VITE_APP_VERSION is injected by the release builder, while getVersion()
  // confirms the native package version at runtime in a Tauri window.
  const [appVersion, setAppVersion] = useState(import.meta.env.VITE_APP_VERSION ?? '0.1.0');
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [rejoinPrompt, setRejoinPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState('');
  const [voice, setVoice] = useState<VoiceConnection | null>(null);
  const [assigningGroup, setAssigningGroup] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ inputs: Device[]; outputs: Device[] }>({ inputs: [], outputs: [] });
  const [capturing, setCapturing] = useState<string | null>(null);
  const [testingMicrophone, setTestingMicrophone] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const voiceRef = useRef<VoiceConnection | null>(null);
  const pressedKeysRef = useRef(new Set<string>());
  const microphoneTestRef = useRef<{ stream: MediaStream; context: AudioContext; frame: number } | null>(null);
  const hasShownRejoinPrompt = useRef(false);
  const joined = lobby !== null;
  const update = (patch: Partial<Preferences>) => setPrefs((value) => ({ ...value, ...patch }));
  const t = translations[prefs.language ?? 'en'];

  useEffect(() => {
    localStorage.setItem('logicomms:preferences', JSON.stringify(prefs));
  }, [prefs]);

  // A lobby is only the live presence list.  Add everyone we meet to local
  // preferences, but never remove them here: assignments must remain
  // adjustable after somebody disconnects.
  useEffect(() => {
    if (!lobby || !userId) return;
    const connectedPeople = lobby.members
        .filter((member) => member.userId !== userId)
        .map(({ userId: memberId, nickname }) => ({ userId: memberId, nickname }));
    if (connectedPeople.length === 0) return;
    setPrefs((current) => {
      const peopleById = new Map(current.people.map((person) => [person.userId, person]));
      let changed = false;
      for (const person of connectedPeople) {
        const previous = peopleById.get(person.userId);
        if (!previous || previous.nickname !== person.nickname) {
          peopleById.set(person.userId, person);
          changed = true;
        }
      }
      return changed ? { ...current, people: [...peopleById.values()] } : current;
    });
  }, [lobby?.members, userId]);

  useEffect(() => {
    if (isTauri()) void getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // An enabled automatic-update preference means "check and ask". The user
  // still explicitly starts NSIS, avoiding a replacement while the app is
  // launching.
  useEffect(() => {
    if (!isTauri()) return;
    void check()
        .then((update) => {
          setAvailableUpdate(update);
          if (update && prefs.autoUpdate) setShowUpdatePrompt(true);
        })
        .catch(() => undefined);
    // Preferences are loaded synchronously, so this is intentionally a
    // launch-only check rather than a new check after every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installUpdate = async () => {
    if (!availableUpdate) return;
    setShowUpdatePrompt(false);
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

  const stopMicrophoneTest = () => {
    const test = microphoneTestRef.current;
    if (test) {
      cancelAnimationFrame(test.frame);
      test.stream.getTracks().forEach((track) => track.stop());
      void test.context.close();
      microphoneTestRef.current = null;
    }
    setTestingMicrophone(false);
    setMicrophoneLevel(0);
  };

  const toggleMicrophoneTest = async () => {
    if (testingMicrophone) return stopMicrophoneTest();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.input === 'default' ? undefined : { exact: prefs.input } } });
      const context = new AudioContext();
      // Chromium/WebView supports routing an AudioContext to a chosen output.
      // Fall back to the system output when that optional API is unavailable.
      const sinkContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
      if (prefs.output !== 'default') await sinkContext.setSinkId?.(prefs.output).catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const monitor = context.createGain();
      monitor.gain.value = prefs.outputVolume / 100;
      context.createMediaStreamSource(stream).connect(analyser);
      analyser.connect(monitor).connect(context.destination);
      const samples = new Uint8Array(analyser.fftSize);
      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (const sample of samples) total += ((sample - 128) / 128) ** 2;
        setMicrophoneLevel(Math.min(1, Math.sqrt(total / samples.length) * 5));
        const current = microphoneTestRef.current;
        if (current) current.frame = requestAnimationFrame(measure);
      };
      microphoneTestRef.current = { stream, context, frame: 0 };
      setTestingMicrophone(true);
      measure();
    } catch (caught) {
      setStatus(`Microphone test unavailable: ${(caught as Error).message}`);
      stopMicrophoneTest();
    }
  };

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, []);

  useEffect(() => () => stopMicrophoneTest(), []);

  useEffect(() => {
    if (!showSettings) stopMicrophoneTest();
  }, [showSettings]);

  // Windows/WebView permissions are granted per application, not by NSIS
  // during installation. Request the microphone on first app launch and
  // immediately release it, so talking later never causes a surprise prompt.
  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
        ?.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          if (!cancelled) {
            setMicrophoneMessage(null);
            refreshDevices();
          }
        })
        .catch(() => {
          if (!cancelled) setMicrophoneMessage('Microphone access was not granted. You can enable it in Windows Settings.');
        });
    return () => {
      cancelled = true;
    };
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
    if (!userId || !prefs.lastLobbyCode || hasShownRejoinPrompt.current) return;
    hasShownRejoinPrompt.current = true;
    setRejoinPrompt(prefs.lastLobbyCode);
  }, [prefs.lastLobbyCode, userId]);

  useEffect(() => {
    if (!lobby) return;
    const connection = new VoiceConnection(setStatus, (identity, active) => {
      const memberId = identity.replace(/^u_/, '');
      setIncomingTalkers((current) => active ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId));
    }, (identity) => setReplyTarget(identity ? identity.replace(/^u_/, '') : null));
    void callLobbyApi<VoiceCredentials>({ action: 'livekitToken', code: lobby.code })
        .then(async (credentials) => {
          await connection.connect(credentials);
          setVoice(connection);
        })
        .catch((caught) => setStatus(`Voice unavailable: ${caught.message}`));
    return () => {
      setVoice(null);
      setIncomingTalkers([]);
      setReplyTarget(null);
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
    voice?.setInputVolume(prefs.inputVolume / 100);
  }, [voice, prefs.inputVolume]);

  useEffect(() => {
    voice?.setOutputVolume(prefs.outputVolume / 100);
  }, [voice, prefs.outputVolume]);

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

  // Realtime updates make joins/leaves visible immediately. The heartbeat is
  // still retained above solely to expire abandoned lobby memberships.
  useEffect(() => {
    if (!lobby) return;
    let refreshQueued = false;
    const refresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      window.setTimeout(() => {
        refreshQueued = false;
        void callLobbyApi<Lobby>({ action: 'getLobby', code: lobby.code })
            .then((nextLobby) => {
              if (nextLobby) setLobby(nextLobby);
            })
            .catch(() => undefined);
      }, 0);
    };
    return subscribeToLobby(lobby.code, refresh);
  }, [lobby?.code]);

  useEffect(() => {
    if (!isTauri()) return;
    const applyOverlayLayout = async () => {
      const overlay = await WebviewWindow.getByLabel('overlay');
      const monitor = await currentMonitor();
      if (!overlay || !monitor) return;
      const scale = Math.max(0.75, Math.min(1.5, prefs.overlayScale / 100));
      const size = new LogicalSize(240 * scale, 360 * scale);
      const workAreaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
      const workAreaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);
      const margin = 12;
      const right = workAreaPosition.x + workAreaSize.width - size.width - margin;
      const bottom = workAreaPosition.y + workAreaSize.height - size.height - margin;
      const x = prefs.overlayPosition.endsWith('right') ? right : workAreaPosition.x + margin;
      const y = prefs.overlayPosition.startsWith('bottom') ? bottom : workAreaPosition.y + margin;
      await overlay.setSize(size);
      await overlay.setPosition(new LogicalPosition(x, y));
    };
    void applyOverlayLayout().catch(() => undefined);
  }, [prefs.overlayPosition, prefs.overlayScale]);

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
      const nextLobby = await callLobbyApi<Lobby>({ action: 'createLobby', nickname: prefs.nickname, code: newLobbyCode });
      setLobby(nextLobby);
      update({ lastLobbyCode: nextLobby.code });
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
      const nextLobby = await callLobbyApi<Lobby>({ action: 'joinLobby', code, nickname: prefs.nickname });
      setLobby(nextLobby);
      update({ lastLobbyCode: nextLobby.code });
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
      update({ lastLobbyCode: undefined });
      setStatus('Ready');
    } catch (caught) {
      setStatus((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rejoinLastLobby = async () => {
    if (!rejoinPrompt || !prefs.nickname.trim()) return setStatus('Choose a nickname first.');
    const lastCode = rejoinPrompt;
    setRejoinPrompt(null);
    setBusy(true);
    try {
      try {
        setLobby(await callLobbyApi<Lobby>({ action: 'joinLobby', code: lastCode, nickname: prefs.nickname }));
      } catch (caught) {
        if (!(caught as Error).message.includes('no longer exists')) throw caught;
        setLobby(await callLobbyApi<Lobby>({ action: 'createLobby', code: lastCode, nickname: prefs.nickname }));
      }
      update({ lastLobbyCode: lastCode });
      setStatus('Connected');
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
      else if (routeId === 'reply') { if (replyTarget) selected.add(replyTarget); }
      else prefs.groups.find((group) => group.id === routeId)?.members.forEach((memberId) => selected.add(memberId));
    }
    return selected;
  }, [lobby, prefs.groups, replyTarget, transmitting, userId]);

  const outgoingNames = useMemo(
      () => lobby?.members.filter((member) => outgoingTargets.has(member.userId)).map((member) => member.nickname) ?? [],
      [lobby, outgoingTargets],
  );
  const incomingNames = useMemo(
      () => lobby?.members.filter((member) => incomingTalkers.includes(member.userId)).map((member) => member.nickname) ?? [],
      [incomingTalkers, lobby],
  );

  const knownPeople = useMemo(() => {
    const peopleById = new Map(prefs.people.map((person) => [person.userId, person]));
    // Preserve memberships created before this address book existed too.
    prefs.groups.flatMap((group) => group.members).forEach((memberId) => {
      if (!peopleById.has(memberId)) peopleById.set(memberId, { userId: memberId, nickname: 'Previously assigned person' });
    });
    const connectedIds = new Set(lobby?.members.filter((member) => member.userId !== userId).map((member) => member.userId));
    return [...peopleById.values()].sort((a, b) => {
      const connectionOrder = Number(connectedIds.has(b.userId)) - Number(connectedIds.has(a.userId));
      return connectionOrder || a.nickname.localeCompare(b.nickname);
    });
  }, [lobby?.members, prefs.groups, prefs.people, userId]);
  const assignedGroup = prefs.groups.find((group) => group.id === assigningGroup);

  useEffect(() => {
    if (!isTauri()) return;
    const publish = () => void emitTo('overlay', 'overlay-state', {
      people: (lobby?.members ?? [])
          .filter((member) => member.userId !== userId)
          .map((member) => ({
            id: member.userId,
            nickname: member.nickname,
            groups: prefs.groups
                .filter((group) => group.members.includes(member.userId))
                .map((group) => ({ id: group.id, name: group.name })),
          })),
      outgoing: [...outgoingTargets],
      incoming: incomingTalkers,
      activeGroups: transmitting,
    }).catch(() => undefined);
    publish();
    const timer = window.setInterval(publish, 1000);
    return () => window.clearInterval(timer);
  }, [incomingTalkers, lobby, outgoingTargets, prefs.groups, transmitting, userId]);

  const addGroup = () => {
    const id = crypto.randomUUID();
    update({ groups: [...prefs.groups, { id, name: 'New group', key: '', members: [] }] });
    setCapturing(id);
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
    const key = event.key === ' ' ? 'SPACE' : event.key.length === 1 ? event.key.toUpperCase() : event.code.replace('Key', '').replace('Digit', '');
    if (!key || ['Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key)) return;
    if (id === 'all') update({ allKey: key });
    else if (id === 'reply') update({ replyKey: key });
    else update({ groups: prefs.groups.map((group) => (group.id === id ? { ...group, key } : group)) });
    setCapturing(null);
  };

  useEffect(() => {
    if (!capturing) return;
    const assign = (event: KeyboardEvent) => {
      event.preventDefault();
      const key = event.key === ' ' ? 'SPACE' : event.key.length === 1 ? event.key.toUpperCase() : event.code.replace('Key', '').replace('Digit', '');
      if (!key || ['Shift', 'Control', 'Alt', 'Meta', 'Escape'].includes(event.key)) return;
      if (capturing === 'all') update({ allKey: key });
      else if (capturing === 'reply') update({ replyKey: key });
      else update({ groups: prefs.groups.map((group) => group.id === capturing ? { ...group, key } : group) });
      setCapturing(null);
    };
    window.addEventListener('keydown', assign, true);
    return () => window.removeEventListener('keydown', assign, true);
  }, [capturing, prefs.groups]);

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
            {joined ? t.connected : status}
          </div>
          <button className="icon-button" aria-label="Settings" onClick={() => setShowSettings((value) => !value)}>
            <Settings2 size={17} />
          </button>
        </header>

        {showUpdatePrompt && availableUpdate && (
            <div className="update-prompt-backdrop" role="presentation">
              <section className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-title">
                <h2 id="update-title">Update available</h2>
                <p>LogiComms v{availableUpdate.version} is ready to install.</p>
                <div className="update-prompt-actions">
                  <button className="quiet" onClick={() => setShowUpdatePrompt(false)}>Later</button>
                  <button className="primary" onClick={() => void installUpdate()}>Update now</button>
                </div>
              </section>
            </div>
        )}

        {rejoinPrompt && !joined && (
            <div className="update-prompt-backdrop" role="presentation">
              <section className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="rejoin-title">
                <h2 id="rejoin-title">Rejoin your last lobby?</h2>
                <p>Would you like to rejoin <b>{rejoinPrompt}</b>? If it has expired, a lobby with the same code will be created.</p>
                <div className="update-prompt-actions">
                  <button className="quiet" onClick={() => { update({ lastLobbyCode: undefined }); setRejoinPrompt(null); }}>No thanks</button>
                  <button className="primary" disabled={busy} onClick={() => void rejoinLastLobby()}>Rejoin</button>
                </div>
              </section>
            </div>
        )}

        {!joined ? (
            <section className="welcome">
              <h1>{t.lobby}</h1>
              <p>Join a lobby by its single-word name, or create one.</p>
              <label className="main-nickname">
                {t.yourNickname}
                <input
                    value={prefs.nickname}
                    maxLength={32}
                    onChange={(event) => update({ nickname: event.target.value })}
                    placeholder="Your name"
                />
              </label>
              <label className="main-nickname">
                {t.lobbyCode}
                <input value={code} onChange={(event) => setCode(event.target.value)} placeholder={t.lobbyCode} />
              </label>
              {microphoneMessage && <p className="permission-note">{microphoneMessage}</p>}
              <button className="primary" disabled={busy} onClick={() => void join()}>
                {t.joinLobby}
              </button>
              <label className="create-lobby-code">
                {t.customLobby} <small>{t.optional}</small>
                <input
                    value={newLobbyCode}
                    maxLength={32}
                    onChange={(event) => setNewLobbyCode(event.target.value.toLowerCase())}
                    placeholder="myfriends"
                />
              </label>
              <button className="quiet" disabled={busy} onClick={() => void create()}>
                {t.createLobby}
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
                  <LogOut size={14} /> {t.leave}
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
                <Users size={15} /> {t.people} <em>{lobby.members.length}</em>
              </span>
                  <span className="muted">{t.inLobby}</span>
                </div>
                <div className="member-list">
                  {lobby.members.map((member) => (
                      <div
                        className={`member${outgoingTargets.has(member.userId) ? ' outgoing' : ''}${incomingTalkers.includes(member.userId) ? ' incoming' : ''}`}
                        key={member.userId}
                        draggable={member.userId !== userId}
                        onDragStart={(event) => event.dataTransfer.setData('application/x-logicomms-person', member.userId)}
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
                <KeyRound size={15} /> {t.yourGroups}
              </span>
                  <button className="text-button" onClick={() => addGroup()}>
                    <Plus size={14} /> {t.group}
                  </button>
                </div>
                <div className="group-list">
                  {prefs.groups.map((group) => (
                      <div className="group-wrap" key={group.id}>
                        <div className="group" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                          const memberId = event.dataTransfer.getData('application/x-logicomms-person');
                          if (memberId && !group.members.includes(memberId)) update({ groups: prefs.groups.map((entry) => entry.id === group.id ? { ...entry, members: [...entry.members, memberId] } : entry) });
                        }}>
                          <button className="group-main" onClick={() => setCapturing(group.id)}>
                      <span className="group-name" onDoubleClick={(event) => {
                        event.preventDefault(); event.stopPropagation();
                        const name = window.prompt(t.groupName, group.name)?.trim();
                        if (name) update({ groups: prefs.groups.map((entry) => entry.id === group.id ? { ...entry, name } : entry) });
                      }}>
                        {group.name}
                        <small>{group.members.length} people</small>
                      </span>
                            <Key active={transmitting.includes(group.id)}>{group.key || '—'}</Key>
                          </button>
                          <button className="edit" onClick={() => setAssigningGroup(group.id)}>
                            •••
                          </button>
                        </div>
                        {false && (
                            <div className="group-members">
                              <div className="group-details">
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
                              </div>
                              <div className="group-member-heading">
                                <span>People</span>
                                <small>Saved locally — connected people appear first</small>
                              </div>
                              <div className="group-person-list">
                                {knownPeople.length === 0 ? (
                                    <p className="empty-group">People you meet in a lobby will stay available here.</p>
                                ) : knownPeople.map((person) => {
                                  const connected = lobby?.members.some((member) => member.userId === person.userId);
                                  const selected = group.members.includes(person.userId);
                                  return (
                                      <button
                                          type="button"
                                          className={`group-person${selected ? ' selected' : ''}`}
                                          aria-pressed={selected}
                                          key={person.userId}
                                          onClick={() => update({
                                            groups: prefs.groups.map((entry) => entry.id !== group.id ? entry : {
                                              ...entry,
                                              members: selected
                                                  ? entry.members.filter((id) => id !== person.userId)
                                                  : [...entry.members, person.userId],
                                            }),
                                          })}
                                      >
                                        <span className="avatar">{person.nickname.slice(0, 1)}</span>
                                        <span className="group-person-copy">
                                          <strong>{person.nickname}</strong>
                                          <small className={connected ? 'online' : ''}>{connected ? 'In this lobby' : 'Saved person'}</small>
                                        </span>
                                        <span className="assignment-state">{selected ? <><Check size={14} /> Added</> : 'Add'}</span>
                                      </button>
                                  );
                                })}
                              </div>
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

        {assignedGroup && (
            <div className="assignment-backdrop" role="presentation" onMouseDown={() => setAssigningGroup(null)}>
              <section className="assignment-modal" role="dialog" aria-modal="true" aria-label={t.assignPeople} onMouseDown={(event) => event.stopPropagation()}>
                <div className="section-title"><span>{t.assignPeople}: {assignedGroup.name}</span><button className="text-button" onClick={() => setAssigningGroup(null)}>{t.done}</button></div>
                <p className="assignment-help">{t.savedLocally}</p>
                <div className="group-person-list">
                  {knownPeople.length === 0 ? <p className="empty-group">{t.noPeople}</p> : knownPeople.map((person) => {
                    const selected = assignedGroup.members.includes(person.userId);
                    const connected = lobby?.members.some((member) => member.userId === person.userId);
                    return <button type="button" className={`group-person${selected ? ' selected' : ''}`} aria-pressed={selected} key={person.userId} onClick={() => update({
                      groups: prefs.groups.map((group) => group.id !== assignedGroup.id ? group : { ...group, members: selected ? group.members.filter((id) => id !== person.userId) : [...group.members, person.userId] }),
                    })}>
                      <span className="avatar">{person.nickname.slice(0, 1)}</span><span className="group-person-copy"><strong>{person.nickname}</strong><small className={connected ? 'online' : ''}>{connected ? t.inThisLobby : t.savedPerson}</small></span><span className="assignment-state">{selected ? <><Check size={14} /> {t.added}</> : t.add}</span>
                    </button>;
                  })}
                </div>
              </section>
            </div>
        )}

        {capturing && (
            <div className="assignment-backdrop" role="presentation">
              <section className="capture-modal" role="dialog" aria-modal="true" aria-label={t.hotkey}>
                <KeyRound size={22} /><h2>{t.hotkey}</h2><p>{t.waiting}</p>
                <button className="quiet" onClick={() => setCapturing(null)}>{t.cancel}</button>
              </section>
            </div>
        )}

        {!prefs.language && (
            <div className="assignment-backdrop" role="presentation">
              <section className="capture-modal language-modal" role="dialog" aria-modal="true" aria-label={t.chooseLanguage}>
                <h2>{t.chooseLanguage}</h2><p>{t.languageHint}</p>
                <div className="language-options"><button onClick={() => update({ language: 'en' })}>🇬🇧 {t.english}</button><button onClick={() => update({ language: 'cs' })}>🇨🇿 {t.czech}</button></div>
              </section>
            </div>
        )}

        {showSettings && (
            <aside className="settings-panel">
              <div className="section-title">
                <span>{t.settings}</span>
                <button className="text-button" onClick={() => setShowSettings(false)}>
                  {t.done}
                </button>
              </div>
              <label>
                {t.languageSetting}
                <select value={prefs.language ?? 'en'} onChange={(event) => update({ language: event.target.value as Language })}>
                  <option value="en">🇬🇧 English</option>
                  <option value="cs">🇨🇿 Čeština</option>
                </select>
              </label>
              <label>
                {t.nickname}
                <input value={prefs.nickname} maxLength={32} onChange={(event) => update({ nickname: event.target.value })} />
              </label>
              <label>
                {t.inputDevice}
                <select value={prefs.input} onChange={(event) => update({ input: event.target.value })}>
                  <option value="default">System default</option>
                  {devices.inputs.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                  ))}
                </select>
              </label>
              <label className="volume-control">
                Microphone volume <span>{prefs.inputVolume}%</span>
                <input type="range" min="0" max="200" step="5" value={prefs.inputVolume} onChange={(event) => update({ inputVolume: Number(event.target.value) })} />
              </label>
              <div className="microphone-test">
                <div className="microphone-test-heading"><span>{testingMicrophone ? 'Testing microphone now' : 'Test microphone'}</span><span>{Math.round(microphoneLevel * 100)}%</span></div>
                <div className="microphone-meter" aria-label="Microphone level"><i style={{ transform: `scaleX(${microphoneLevel})` }} /></div>
                <button className={testingMicrophone ? 'quiet' : 'primary'} onClick={() => void toggleMicrophoneTest()}>{testingMicrophone ? 'Stop test' : 'Test microphone'}</button>
              </div>
              <label>
                {t.outputDevice}
                <select value={prefs.output} onChange={(event) => update({ output: event.target.value })}>
                  <option value="default">System default</option>
                  {devices.outputs.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                  ))}
                </select>
              </label>
              <label className="volume-control">
                Speaker volume <span>{prefs.outputVolume}%</span>
                <input type="range" min="0" max="100" step="5" value={prefs.outputVolume} onChange={(event) => update({ outputVolume: Number(event.target.value) })} />
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
              <label className="toggle">
                <input
                    type="checkbox"
                    checked={prefs.autoUpdate}
                    onChange={(event) => update({ autoUpdate: event.target.checked })}
                />{' '}
                Automatically check for updates on launch
              </label>
              <label>
                Overlay position
                <select
                    value={prefs.overlayPosition}
                    onChange={(event) => update({ overlayPosition: event.target.value as OverlayPosition })}
                >
                  <option value="top-left">Top left</option>
                  <option value="top-right">Top right</option>
                  <option value="bottom-left">Bottom left</option>
                  <option value="bottom-right">Bottom right</option>
                </select>
              </label>
              <label className="overlay-scale-control">
                Overlay size <span>{prefs.overlayScale}%</span>
                <input
                    type="range"
                    min="75"
                    max="150"
                    step="5"
                    value={prefs.overlayScale}
                    onChange={(event) => update({ overlayScale: Number(event.target.value) })}
                />
              </label>
            </aside>
        )}
      </main>
  );
}
