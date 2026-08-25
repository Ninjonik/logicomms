import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import {
  ConnectionState,
  createLocalAudioTrack,
  type DataPacket_Kind,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import {
  AudioLines,
  Copy,
  LoaderCircle,
  LogOut,
  Mic,
  Plus,
  Radio,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import env from "@/config/env";
import { cn } from "@/lib/utils";

interface SessionResponse {
  displayName: string;
  identity: string;
  livekitUrl: string;
  sessionCode: string;
  token: string;
}

type SessionState = SessionResponse & {
  room: Room;
};

type GroupTarget = "all" | "command" | "alpha";
type ShortcutTarget = GroupTarget | `identity:${string}`;

interface WhisperBinding {
  id: string;
  shortcut: string;
  target: ShortcutTarget;
}

interface LocalProfile {
  command: boolean;
  displayName: string;
  squadAlpha: boolean;
}

interface WhisperState {
  active: boolean;
  target: ShortcutTarget;
}

interface ParticipantRow {
  displayName: string;
  id: string;
  identity: string;
  isLocal: boolean;
  isSpeaking: boolean;
  tags: string[];
}

interface WhisperControlMessage {
  active: boolean;
  speaker: string;
  target: ShortcutTarget;
  type: "whisper-control";
}

interface BindingRowProps {
  activeShortcut: string | null;
  binding: WhisperBinding;
  captureId: string | null;
  onCapture: (id: string) => void;
  onRemove: (id: string) => void;
  onTargetChange: (id: string, target: ShortcutTarget) => void;
  targetOptions: { label: string; value: ShortcutTarget }[];
}

const NICKNAME_STORAGE_KEY = "logicomms.nickname";

const starterBindings: WhisperBinding[] = [
  { id: "1", shortcut: "F13", target: "all" },
  { id: "2", shortcut: "F14", target: "command" },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeAccelerator(event: KeyboardEvent) {
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Meta" : "",
  ].filter(Boolean);

  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...modifiers, key].join("+");
}

function buildParticipantLabel(participant: Participant) {
  const callsign = participant.attributes.callsign?.trim();
  if (callsign) {
    return callsign;
  }

  return participant.name?.trim() || participant.identity;
}

function getParticipantTags(participant: Participant) {
  const tags: string[] = [];

  if (participant.attributes.commandNet === "true") {
    tags.push("Command");
  }

  if (participant.attributes.squadAlpha === "true") {
    tags.push("Alpha");
  }

  return tags;
}

function deriveParticipants(room: Room) {
  return [
    room.localParticipant,
    ...Array.from(room.remoteParticipants.values()),
  ];
}

function buildParticipantRows(participants: Participant[]): ParticipantRow[] {
  return participants.map((participant) => ({
    displayName: buildParticipantLabel(participant),
    id: participant.identity,
    identity: participant.identity,
    isLocal: participant.isLocal,
    isSpeaking: participant.isSpeaking,
    tags: getParticipantTags(participant),
  }));
}

function isRemoteParticipant(
  participant: Participant
): participant is RemoteParticipant {
  return !participant.isLocal;
}

function shouldHearTarget(
  target: ShortcutTarget,
  listenerIdentity: string,
  profile: LocalProfile
) {
  if (target === "all") {
    return true;
  }

  if (target === "command") {
    return profile.command;
  }

  if (target === "alpha") {
    return profile.squadAlpha;
  }

  if (target.startsWith("identity:")) {
    return target.slice("identity:".length) === listenerIdentity;
  }

  return false;
}

function parseWhisperMessage(
  payload: Uint8Array
): WhisperControlMessage | null {
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as WhisperControlMessage;
    if (parsed.type !== "whisper-control") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function readStoredNickname() {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
}

function ignorePromise<T>(promise: Promise<T>) {
  promise.catch(() => undefined);
}

function BindingRow({
  activeShortcut,
  binding,
  captureId,
  onCapture,
  onRemove,
  onTargetChange,
  targetOptions,
}: BindingRowProps) {
  const handleCapture = useCallback(() => {
    onCapture(binding.id);
  }, [binding.id, onCapture]);

  const handleRemove = useCallback(() => {
    onRemove(binding.id);
  }, [binding.id, onRemove]);

  const handleTargetChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onTargetChange(binding.id, event.target.value as ShortcutTarget);
    },
    [binding.id, onTargetChange]
  );

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        activeShortcut === binding.id
          ? "border-stone-900 bg-stone-100"
          : "border-stone-200 bg-stone-50"
      )}
    >
      <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)_100px]">
        <button
          className="rounded-lg border border-stone-300 border-dashed bg-white px-3 py-2.5 text-left text-sm text-stone-900"
          onClick={handleCapture}
          type="button"
        >
          {captureId === binding.id
            ? "Press any key..."
            : binding.shortcut || "Unassigned"}
        </button>

        <select
          className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none transition focus:border-stone-400"
          onChange={handleTargetChange}
          value={binding.target}
        >
          {targetOptions.map((target) => (
            <option key={target.value} value={target.value}>
              {target.label}
            </option>
          ))}
        </select>

        <Button
          className="border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
          onClick={handleRemove}
          variant="outline"
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

async function requestSession(
  path: string,
  body: { displayName: string; sessionCode?: string }
) {
  const response = await fetch(`${env.API_URL}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = (await response.json()) as
    | SessionResponse
    | { error: string };
  if (!response.ok || "error" in payload) {
    throw new Error(
      "error" in payload ? payload.error : "Session request failed."
    );
  }

  return payload;
}

export function HomePage() {
  const [joinCode, setJoinCode] = useState("");
  const [callsign, setCallsign] = useState("");
  const [status, setStatus] = useState("Ready.");
  const [isBusy, setIsBusy] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [bindings, setBindings] = useState(starterBindings);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [activeShortcut, setActiveShortcut] = useState<string | null>(null);
  const [profile, setProfile] = useState<LocalProfile>({
    command: true,
    displayName: "",
    squadAlpha: false,
  });
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const micPublicationRef = useRef<LocalTrackPublication | null>(null);
  const whisperStateRef = useRef<Map<string, WhisperState>>(new Map());

  useEffect(() => {
    const stored = readStoredNickname();
    if (stored) {
      setCallsign(stored);
      setProfile((current) => ({ ...current, displayName: stored }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    localStorage.setItem(NICKNAME_STORAGE_KEY, callsign);
  }, [callsign]);

  useEffect(() => {
    if (!captureId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      setBindings((current) =>
        current.map((binding) =>
          binding.id === captureId
            ? { ...binding, shortcut: normalizeAccelerator(event) }
            : binding
        )
      );
      setCaptureId(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [captureId]);

  const applyAudioRouting = useCallback(
    (room: Room, participantList = deriveParticipants(room)) => {
      const listenerIdentity = room.localParticipant.identity;

      for (const participant of participantList) {
        if (!isRemoteParticipant(participant)) {
          continue;
        }

        const whisperState = whisperStateRef.current.get(participant.identity);
        const shouldHear =
          whisperState?.active === true &&
          shouldHearTarget(whisperState.target, listenerIdentity, profile);

        participant.setVolume(shouldHear ? 1 : 0, Track.Source.Microphone);
      }
    },
    [profile]
  );

  const syncParticipantState = useCallback(
    (room: Room) => {
      const nextParticipants = deriveParticipants(room);
      setParticipants(nextParticipants);
      applyAudioRouting(room, nextParticipants);
    },
    [applyAudioRouting]
  );

  const broadcastWhisperState = useCallback(
    async (target: ShortcutTarget, active: boolean) => {
      if (!session) {
        return;
      }

      const payload: WhisperControlMessage = {
        active,
        speaker: session.identity,
        target,
        type: "whisper-control",
      };

      await session.room.localParticipant.publishData(
        encoder.encode(JSON.stringify(payload)),
        {
          reliable: true,
          topic: "whisper-control",
        }
      );
    },
    [session]
  );

  const ensurePublishedMic = useCallback(async (room: Room) => {
    if (audioTrackRef.current === null) {
      audioTrackRef.current = await createLocalAudioTrack();
    }

    if (micPublicationRef.current === null) {
      micPublicationRef.current = await room.localParticipant.publishTrack(
        audioTrackRef.current,
        {
          name: "whisper-mic",
          source: Track.Source.Microphone,
        }
      );
      await micPublicationRef.current.mute();
    }
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    const { room } = session;
    const updateParticipants = () => {
      syncParticipantState(room);
    };

    const updateConnectionState = (state: ConnectionState) => {
      setStatus(
        state === ConnectionState.Connected
          ? `Connected to ${session.sessionCode}.`
          : `Connection state: ${state}`
      );
    };

    const handleDataReceived = (
      payload: Uint8Array,
      participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string
    ) => {
      if (topic !== "whisper-control") {
        return;
      }

      const message = parseWhisperMessage(payload);
      if (!message) {
        return;
      }

      if (participant && participant.identity !== message.speaker) {
        return;
      }

      whisperStateRef.current.set(message.speaker, {
        active: message.active,
        target: message.target,
      });

      syncParticipantState(room);
    };

    room.on(RoomEvent.ParticipantConnected, updateParticipants);
    room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
    room.on(RoomEvent.ActiveSpeakersChanged, updateParticipants);
    room.on(RoomEvent.ConnectionStateChanged, updateConnectionState);
    room.on(RoomEvent.ParticipantAttributesChanged, updateParticipants);
    room.on(RoomEvent.TrackSubscribed, updateParticipants);
    room.on(RoomEvent.TrackUnsubscribed, updateParticipants);
    room.on(RoomEvent.DataReceived, handleDataReceived);

    syncParticipantState(room);
    return () => {
      room.off(RoomEvent.ParticipantConnected, updateParticipants);
      room.off(RoomEvent.ParticipantDisconnected, updateParticipants);
      room.off(RoomEvent.ActiveSpeakersChanged, updateParticipants);
      room.off(RoomEvent.ConnectionStateChanged, updateConnectionState);
      room.off(RoomEvent.ParticipantAttributesChanged, updateParticipants);
      room.off(RoomEvent.TrackSubscribed, updateParticipants);
      room.off(RoomEvent.TrackUnsubscribed, updateParticipants);
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [session, syncParticipantState]);

  const startWhisper = useCallback(
    async (target: ShortcutTarget) => {
      if (!session) {
        return;
      }

      await ensurePublishedMic(session.room);

      whisperStateRef.current.set(session.identity, { active: true, target });
      await micPublicationRef.current.unmute();
      await broadcastWhisperState(target, true);
      syncParticipantState(session.room);
    },
    [broadcastWhisperState, ensurePublishedMic, session, syncParticipantState]
  );

  const stopWhisper = useCallback(
    async (target: ShortcutTarget) => {
      if (!(session && micPublicationRef.current)) {
        return;
      }

      whisperStateRef.current.set(session.identity, { active: false, target });
      await micPublicationRef.current.mute();
      await broadcastWhisperState(target, false);
      syncParticipantState(session.room);
    },
    [broadcastWhisperState, session, syncParticipantState]
  );

  useEffect(() => {
    if (!session) {
      return;
    }

    let cancelled = false;

    const syncBindings = async () => {
      await Promise.all(
        bindings
          .filter((binding) => binding.shortcut)
          .map(async (binding) => {
            if (await isRegistered(binding.shortcut)) {
              await unregister(binding.shortcut);
            }

            await register(binding.shortcut, async (event) => {
              if (cancelled) {
                return;
              }

              if (event.state === "Pressed") {
                setActiveShortcut(binding.id);
                await startWhisper(binding.target);
              }

              if (event.state === "Released") {
                setActiveShortcut(null);
                await stopWhisper(binding.target);
              }
            });
          })
      );
    };

    ignorePromise(syncBindings());

    return () => {
      cancelled = true;
      for (const binding of bindings) {
        if (binding.shortcut) {
          ignorePromise(unregister(binding.shortcut));
        }
      }
    };
  }, [bindings, session, startWhisper, stopWhisper]);

  useEffect(() => {
    if (!session) {
      return;
    }

    ignorePromise(
      session.room.localParticipant.setAttributes({
        callsign: profile.displayName,
        commandNet: String(profile.command),
        squadAlpha: String(profile.squadAlpha),
      })
    );

    syncParticipantState(session.room);
  }, [profile, session, syncParticipantState]);

  const connectToRoom = useCallback(
    async (payload: SessionResponse) => {
      const room = new Room();
      setStatus(`Connecting to ${payload.sessionCode}...`);

      await room.connect(payload.livekitUrl, payload.token);
      await ensurePublishedMic(room);

      const nextProfile = {
        command: true,
        displayName: payload.displayName,
        squadAlpha: false,
      };

      setProfile(nextProfile);
      whisperStateRef.current = new Map();
      setSession({ ...payload, room });
      setParticipants(deriveParticipants(room));

      await room.localParticipant.setAttributes({
        callsign: nextProfile.displayName,
        commandNet: String(nextProfile.command),
        squadAlpha: String(nextProfile.squadAlpha),
      });

      setStatus(`Connected to ${payload.sessionCode}.`);
    },
    [ensurePublishedMic]
  );

  const handleCreateSession = useCallback(async () => {
    setIsBusy(true);
    setStatus("Creating session...");

    try {
      const payload = await requestSession("/api/session/create", {
        displayName: callsign.trim(),
      });
      await navigator.clipboard.writeText(payload.sessionCode);
      await connectToRoom(payload);
      setStatus(`Session ${payload.sessionCode} created and copied.`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to create session."
      );
    } finally {
      setIsBusy(false);
    }
  }, [callsign, connectToRoom]);

  const handleJoinSession = useCallback(async () => {
    setIsBusy(true);
    setStatus("Joining session...");

    try {
      const payload = await requestSession("/api/session/join", {
        displayName: callsign.trim(),
        sessionCode: joinCode.trim().toLowerCase(),
      });
      await connectToRoom(payload);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to join session."
      );
    } finally {
      setIsBusy(false);
    }
  }, [callsign, connectToRoom, joinCode]);

  const disconnect = useCallback(async () => {
    if (session) {
      await Promise.all(
        bindings
          .filter((binding) => binding.shortcut)
          .map((binding) => unregister(binding.shortcut).catch(() => undefined))
      );

      await micPublicationRef.current.mute().catch(() => undefined);

      session.room.disconnect();
    }

    micPublicationRef.current = null;
    whisperStateRef.current = new Map();
    setSession(null);
    setParticipants([]);
    setStatus("Disconnected.");
    setActiveShortcut(null);
  }, [bindings, session]);

  const participantRows = useMemo(
    () => buildParticipantRows(participants),
    [participants]
  );

  const targetOptions = useMemo(() => {
    const options = [
      { label: "Broadcast / All Hands", value: "all" as ShortcutTarget },
      { label: "Command Net", value: "command" as ShortcutTarget },
      { label: "Squad Alpha", value: "alpha" as ShortcutTarget },
    ];

    for (const participant of participantRows) {
      if (participant.isLocal) {
        continue;
      }

      options.push({
        label: participant.displayName,
        value: `identity:${participant.identity}` as ShortcutTarget,
      });
    }

    return options;
  }, [participantRows]);

  const whisperSummary = activeShortcut
    ? (bindings.find((binding) => binding.id === activeShortcut)?.target ??
      "all")
    : "idle";

  const sessionReady = session !== null;

  const statCards = [
    { label: "Status", value: sessionReady ? "Connected" : "Offline" },
    { label: "Push-to-talk", value: whisperSummary },
    { label: "Participants", value: String(participantRows.length) },
  ];

  const handleCopySessionCode = useCallback(() => {
    if (!session) {
      return;
    }

    ignorePromise(navigator.clipboard.writeText(session.sessionCode));
  }, [session]);

  const handleDisconnect = useCallback(() => {
    ignorePromise(disconnect());
  }, [disconnect]);

  const handleProfileCallsignChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setCallsign(value);
      setProfile((current) => ({
        ...current,
        displayName: value,
      }));
    },
    []
  );

  const handleLandingCallsignChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setCallsign(event.target.value);
    },
    []
  );

  const handleJoinCodeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setJoinCode(event.target.value);
    },
    []
  );

  const handleToggleCommand = useCallback(() => {
    setProfile((current) => ({
      ...current,
      command: !current.command,
    }));
  }, []);

  const handleToggleAlpha = useCallback(() => {
    setProfile((current) => ({
      ...current,
      squadAlpha: !current.squadAlpha,
    }));
  }, []);

  const handleJoinClick = useCallback(() => {
    ignorePromise(handleJoinSession());
  }, [handleJoinSession]);

  const handleCreateClick = useCallback(() => {
    ignorePromise(handleCreateSession());
  }, [handleCreateSession]);

  const handleAddBinding = useCallback(() => {
    setBindings((current) => [
      ...current,
      {
        id: globalThis.crypto.randomUUID(),
        shortcut: "",
        target: "all",
      },
    ]);
  }, []);

  const handleCaptureBinding = useCallback((id: string) => {
    setCaptureId(id);
  }, []);

  const handleRemoveBinding = useCallback((id: string) => {
    setBindings((current) =>
      current.filter((candidate) => candidate.id !== id)
    );
  }, []);

  const handleBindingTargetChange = useCallback(
    (id: string, target: ShortcutTarget) => {
      setBindings((current) =>
        current.map((candidate) =>
          candidate.id === id ? { ...candidate, target } : candidate
        )
      );
    },
    []
  );

  return (
    <main className="min-h-screen bg-stone-100 text-stone-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="border-stone-200 border-b pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1">
              <p className="font-medium text-stone-500 text-xs uppercase tracking-[0.18em]">
                LogiComms
              </p>
              <h1 className="font-semibold text-2xl text-stone-950">
                {session
                  ? `Session ${session.sessionCode}`
                  : "Voice session control"}
              </h1>
              <p className="text-sm text-stone-600">{status}</p>
            </div>

            {session ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  className="border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                  onClick={handleCopySessionCode}
                  variant="outline"
                >
                  <Copy />
                  Copy code
                </Button>
                <Button
                  className="bg-stone-900 text-white hover:bg-stone-800"
                  onClick={handleDisconnect}
                >
                  <LogOut />
                  Disconnect
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="grid flex-1 gap-6 py-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <section className="space-y-6">
            {session ? (
              <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 border-stone-200 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="font-semibold text-base text-stone-950">
                      Profile
                    </h2>
                    <p className="text-sm text-stone-600">
                      This name and routing preference update live for this
                      device.
                    </p>
                  </div>
                  <p className="text-sm text-stone-500">{session.identity}</p>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="block space-y-2">
                    <span className="font-medium text-sm text-stone-700">
                      Display name
                    </span>
                    <input
                      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none transition focus:border-stone-400"
                      onChange={handleProfileCallsignChange}
                      placeholder="Commander_A"
                      value={callsign}
                    />
                  </label>

                  <div className="grid gap-2 sm:grid-cols-2 md:min-w-72">
                    <button
                      className={cn(
                        "rounded-lg border px-4 py-2.5 text-left text-sm transition",
                        profile.command
                          ? "border-stone-900 bg-stone-900 text-white"
                          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                      )}
                      onClick={handleToggleCommand}
                      type="button"
                    >
                      Command net
                    </button>
                    <button
                      className={cn(
                        "rounded-lg border px-4 py-2.5 text-left text-sm transition",
                        profile.squadAlpha
                          ? "border-stone-900 bg-stone-900 text-white"
                          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                      )}
                      onClick={handleToggleAlpha}
                      type="button"
                    >
                      Squad alpha
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
                  <div className="space-y-1">
                    <h2 className="font-semibold text-base text-stone-950">
                      Start here
                    </h2>
                    <p className="text-sm text-stone-600">
                      Enter a name, then join an existing session or create a
                      new one.
                    </p>
                  </div>

                  <div className="mt-5 space-y-4">
                    <label className="block space-y-2">
                      <span className="font-medium text-sm text-stone-700">
                        Display name
                      </span>
                      <input
                        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none transition focus:border-stone-400"
                        onChange={handleLandingCallsignChange}
                        placeholder="Commander_A"
                        value={callsign}
                      />
                    </label>

                    <p className="text-stone-500 text-xs">
                      Saved locally on this device.
                    </p>
                  </div>
                </section>

                <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="block space-y-2">
                        <span className="font-medium text-sm text-stone-700">
                          Session code
                        </span>
                        <input
                          className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 lowercase tracking-[0.12em] outline-none transition focus:border-stone-400"
                          onChange={handleJoinCodeChange}
                          placeholder="falcon"
                          value={joinCode}
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Button
                        className="bg-stone-900 text-white hover:bg-stone-800"
                        disabled={
                          isBusy ||
                          joinCode.trim().length === 0 ||
                          callsign.trim().length === 0
                        }
                        onClick={handleJoinClick}
                      >
                        {isBusy ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Radio />
                        )}
                        Join
                      </Button>
                      <Button
                        className="border-stone-300 bg-white text-stone-800 hover:bg-stone-50"
                        disabled={isBusy || callsign.trim().length === 0}
                        onClick={handleCreateClick}
                        variant="outline"
                      >
                        {isBusy ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Plus />
                        )}
                        Create
                      </Button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 border-stone-200 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold text-base text-stone-950">
                    Push-to-talk bindings
                  </h2>
                  <p className="text-sm text-stone-600">
                    Hold the assigned key to transmit. Release to mute.
                  </p>
                </div>
                <Button
                  className="bg-stone-900 text-white hover:bg-stone-800"
                  onClick={handleAddBinding}
                  size="sm"
                >
                  <Plus />
                  Add binding
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                {bindings.map((binding) => (
                  <BindingRow
                    activeShortcut={activeShortcut}
                    binding={binding}
                    captureId={captureId}
                    key={binding.id}
                    onCapture={handleCaptureBinding}
                    onRemove={handleRemoveBinding}
                    onTargetChange={handleBindingTargetChange}
                    targetOptions={targetOptions}
                  />
                ))}
              </div>
            </section>
          </section>

          <aside className="space-y-6">
            <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Mic className="size-4 text-stone-500" />
                <h2 className="font-semibold text-base text-stone-950">
                  Session overview
                </h2>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                {statCards.map((card) => (
                  <div
                    className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3"
                    key={card.label}
                  >
                    <p className="font-medium text-stone-500 text-xs uppercase tracking-[0.14em]">
                      {card.label}
                    </p>
                    <p className="mt-2 font-medium text-sm text-stone-900">
                      {card.value}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-600">
                Run the packaged Windows client as Administrator if protected
                games block global shortcuts.
              </div>
            </section>

            <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-stone-500" />
                <h2 className="font-semibold text-base text-stone-950">
                  Participants
                </h2>
              </div>

              <div className="mt-4 space-y-2">
                {participantRows.length > 0 ? (
                  participantRows.map((participant) => (
                    <div
                      className="flex items-start gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3"
                      key={participant.id}
                    >
                      <div className="mt-0.5 h-2.5 w-2.5 rounded-full bg-stone-400" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium text-sm text-stone-900">
                            {participant.displayName}
                          </p>
                          {participant.isSpeaking ? (
                            <AudioLines className="size-3.5 text-stone-700" />
                          ) : null}
                        </div>
                        <p className="truncate text-stone-500 text-xs">
                          {participant.isLocal ? "You" : participant.identity}
                        </p>
                        {participant.tags.length > 0 ? (
                          <p className="mt-1 text-stone-600 text-xs">
                            {participant.tags.join(" / ")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-stone-500">
                    No participants connected yet.
                  </p>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

export const Component = HomePage;
