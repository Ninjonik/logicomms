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
import { LoaderCircle } from "lucide-react";
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

type ShortcutTarget =
  | "all"
  | "reply"
  | `group:${string}`
  | `identity:${string}`;

interface WhisperBinding {
  id: string;
  shortcut: string;
  target: ShortcutTarget;
}

interface WhisperGroup {
  id: string;
  name: string;
}

interface WhisperState {
  active: boolean;
  target: ShortcutTarget;
}

interface ParticipantRow {
  assignedGroupIds: string[];
  displayName: string;
  id: string;
  identity: string;
  isLocal: boolean;
  isSpeaking: boolean;
}

interface WhisperControlMessage {
  active: boolean;
  speaker: string;
  target: ShortcutTarget;
  type: "whisper-control";
}

interface BindingOption {
  label: string;
  value: ShortcutTarget;
}

interface BindingRowProps {
  activeShortcut: string | null;
  binding: WhisperBinding;
  captureId: string | null;
  onCapture: (id: string) => void;
  onRemove: (id: string) => void;
  onTargetChange: (id: string, target: ShortcutTarget) => void;
  targetOptions: BindingOption[];
}

interface GroupRowProps {
  group: WhisperGroup;
  onNameChange: (id: string, value: string) => void;
  onRemove: (id: string) => void;
}

interface GroupToggleProps {
  active: boolean;
  group: WhisperGroup;
  onToggle: (groupId: string) => void;
}

interface ParticipantAssignmentRowProps {
  groups: WhisperGroup[];
  onToggleGroup: (participantIdentity: string, groupId: string) => void;
  participant: ParticipantRow;
}

const NICKNAME_STORAGE_KEY = "logicomms.nickname";
const GROUPS_STORAGE_KEY = "logicomms.groups";
const BINDINGS_STORAGE_KEY = "logicomms.bindings";
const SESSION_ASSIGNMENTS_STORAGE_KEY = "logicomms.sessionAssignments";

const DEFAULT_GROUPS: WhisperGroup[] = [
  { id: "command", name: "Command" },
  { id: "alpha", name: "Alpha" },
];

const DEFAULT_BINDINGS: WhisperBinding[] = [
  { id: "binding-all", shortcut: "F13", target: "all" },
  { id: "binding-command", shortcut: "F14", target: "group:command" },
  { id: "binding-reply", shortcut: "F15", target: "reply" },
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

function ignorePromise<T>(promise: Promise<T>) {
  promise.catch(() => undefined);
}

function buildParticipantLabel(participant: Participant) {
  const callsign = participant.attributes.callsign?.trim();
  if (callsign) {
    return callsign;
  }

  return participant.name?.trim() || participant.identity;
}

function deriveParticipants(room: Room) {
  return [
    room.localParticipant,
    ...Array.from(room.remoteParticipants.values()),
  ];
}

function isRemoteParticipant(
  participant: Participant
): participant is RemoteParticipant {
  return !participant.isLocal;
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

function readStorage<T>(key: string, fallback: T) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeGroupName(value: string) {
  return value.trim().slice(0, 24);
}

function participantAssignmentKey(sessionCode: string, identity: string) {
  return `${sessionCode}:${identity}`;
}

function buildParticipantRows(
  participants: Participant[],
  sessionCode: string | null,
  sessionAssignments: Record<string, string[]>
) {
  return participants.map((participant) => ({
    assignedGroupIds:
      sessionCode === null
        ? []
        : (sessionAssignments[
            participantAssignmentKey(sessionCode, participant.identity)
          ] ?? []),
    displayName: buildParticipantLabel(participant),
    id: participant.identity,
    identity: participant.identity,
    isLocal: participant.isLocal,
    isSpeaking: participant.isSpeaking,
  }));
}

function targetLabel(
  target: ShortcutTarget,
  groups: WhisperGroup[],
  participants: ParticipantRow[]
) {
  if (target === "all") {
    return "All";
  }

  if (target === "reply") {
    return "Reply";
  }

  if (target.startsWith("group:")) {
    const group = groups.find((candidate) => candidate.id === target.slice(6));
    return group?.name ?? "Group";
  }

  if (target.startsWith("identity:")) {
    const participant = participants.find(
      (candidate) => candidate.identity === target.slice(9)
    );
    return participant?.displayName ?? "Direct";
  }

  return target;
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
        "grid gap-2 border px-2 py-2 sm:grid-cols-[120px_minmax(0,1fr)_72px]",
        activeShortcut === binding.id ? "bg-muted" : "bg-background"
      )}
    >
      <button
        className="border px-2 py-1 text-left text-xs"
        onClick={handleCapture}
        type="button"
      >
        {captureId === binding.id ? "press key" : binding.shortcut || "unset"}
      </button>

      <select
        className="border px-2 py-1 text-xs"
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
        className="h-auto px-2 py-1 text-xs"
        onClick={handleRemove}
        variant="outline"
      >
        remove
      </Button>
    </div>
  );
}

function GroupRow({ group, onNameChange, onRemove }: GroupRowProps) {
  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onNameChange(group.id, event.target.value);
    },
    [group.id, onNameChange]
  );

  const handleRemove = useCallback(() => {
    onRemove(group.id);
  }, [group.id, onRemove]);

  return (
    <div className="grid gap-2 border px-2 py-2 sm:grid-cols-[minmax(0,1fr)_72px]">
      <input
        className="border px-2 py-1 text-xs"
        onChange={handleNameChange}
        value={group.name}
      />
      <Button
        className="h-auto px-2 py-1 text-xs"
        onClick={handleRemove}
        variant="outline"
      >
        remove
      </Button>
    </div>
  );
}

function GroupToggle({ active, group, onToggle }: GroupToggleProps) {
  const handleClick = useCallback(() => {
    onToggle(group.id);
  }, [group.id, onToggle]);

  return (
    <button
      className={cn(
        "border px-2 py-1 text-xs",
        active ? "bg-foreground text-background" : "bg-background"
      )}
      onClick={handleClick}
      type="button"
    >
      {group.name}
    </button>
  );
}

function ParticipantAssignmentRow({
  groups,
  participant,
  onToggleGroup,
}: ParticipantAssignmentRowProps) {
  const handleToggleGroup = useCallback(
    (groupId: string) => {
      onToggleGroup(participant.identity, groupId);
    },
    [onToggleGroup, participant.identity]
  );

  return (
    <div className="space-y-2 border px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs">{participant.displayName}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {participant.identity}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {participant.isSpeaking ? "speaking" : ""}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {groups.map((group) => (
          <GroupToggle
            active={participant.assignedGroupIds.includes(group.id)}
            group={group}
            key={group.id}
            onToggle={handleToggleGroup}
          />
        ))}
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
    headers: { "Content-Type": "application/json" },
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
  const [status, setStatus] = useState("ready");
  const [isBusy, setIsBusy] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [groups, setGroups] = useState<WhisperGroup[]>(DEFAULT_GROUPS);
  const [bindings, setBindings] = useState<WhisperBinding[]>(DEFAULT_BINDINGS);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [activeShortcut, setActiveShortcut] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [sessionAssignments, setSessionAssignments] = useState<
    Record<string, string[]>
  >({});
  const [lastSpeakerIdentity, setLastSpeakerIdentity] = useState<string | null>(
    null
  );
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const micPublicationRef = useRef<LocalTrackPublication | null>(null);
  const whisperStateRef = useRef<Map<string, WhisperState>>(new Map());

  useEffect(() => {
    setCallsign(readStorage(NICKNAME_STORAGE_KEY, ""));
    setGroups(readStorage(GROUPS_STORAGE_KEY, DEFAULT_GROUPS));
    setBindings(readStorage(BINDINGS_STORAGE_KEY, DEFAULT_BINDINGS));
    setSessionAssignments(readStorage(SESSION_ASSIGNMENTS_STORAGE_KEY, {}));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    localStorage.setItem(NICKNAME_STORAGE_KEY, callsign);
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
    localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
    localStorage.setItem(
      SESSION_ASSIGNMENTS_STORAGE_KEY,
      JSON.stringify(sessionAssignments)
    );
  }, [bindings, callsign, groups, sessionAssignments]);

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

  const participantRows = useMemo(
    () =>
      buildParticipantRows(
        participants,
        session?.sessionCode ?? null,
        sessionAssignments
      ),
    [participants, session?.sessionCode, sessionAssignments]
  );

  const targetMatchesListener = useCallback(
    (target: ShortcutTarget, listenerIdentity: string) => {
      if (target === "all") {
        return true;
      }

      if (target === "reply") {
        return listenerIdentity === lastSpeakerIdentity;
      }

      if (target.startsWith("identity:")) {
        return target.slice(9) === listenerIdentity;
      }

      if (target.startsWith("group:")) {
        if (!session) {
          return false;
        }

        const key = participantAssignmentKey(
          session.sessionCode,
          listenerIdentity
        );
        return (sessionAssignments[key] ?? []).includes(target.slice(6));
      }

      return false;
    },
    [lastSpeakerIdentity, session, sessionAssignments]
  );

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
          targetMatchesListener(whisperState.target, listenerIdentity);

        participant.setVolume(shouldHear ? 1 : 0, Track.Source.Microphone);
      }
    },
    [targetMatchesListener]
  );

  const syncParticipantState = useCallback(
    (room: Room) => {
      const nextParticipants = deriveParticipants(room);
      setParticipants(nextParticipants);
      applyAudioRouting(room, nextParticipants);
    },
    [applyAudioRouting]
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

  const resolveTarget = useCallback(
    (target: ShortcutTarget) => {
      if (target !== "reply") {
        return target;
      }

      if (lastSpeakerIdentity) {
        return `identity:${lastSpeakerIdentity}` as ShortcutTarget;
      }

      return "all";
    },
    [lastSpeakerIdentity]
  );

  const startWhisper = useCallback(
    async (target: ShortcutTarget) => {
      if (!session) {
        return;
      }

      const resolvedTarget = resolveTarget(target);
      await ensurePublishedMic(session.room);
      whisperStateRef.current.set(session.identity, {
        active: true,
        target: resolvedTarget,
      });
      await micPublicationRef.current?.unmute();
      await broadcastWhisperState(resolvedTarget, true);
      syncParticipantState(session.room);
    },
    [
      broadcastWhisperState,
      ensurePublishedMic,
      resolveTarget,
      session,
      syncParticipantState,
    ]
  );

  const stopWhisper = useCallback(
    async (target: ShortcutTarget) => {
      if (!(session && micPublicationRef.current)) {
        return;
      }

      const resolvedTarget = resolveTarget(target);
      whisperStateRef.current.set(session.identity, {
        active: false,
        target: resolvedTarget,
      });
      await micPublicationRef.current.mute();
      await broadcastWhisperState(resolvedTarget, false);
      syncParticipantState(session.room);
    },
    [broadcastWhisperState, resolveTarget, session, syncParticipantState]
  );

  useEffect(() => {
    if (!session) {
      return;
    }

    const { room } = session;

    const handleConnectionStateChanged = (state: ConnectionState) => {
      setStatus(
        state === ConnectionState.Connected
          ? `connected ${session.sessionCode}`
          : `state ${state}`
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

    const handleActiveSpeakersChanged = (activeSpeakers: Participant[]) => {
      const remoteSpeaker = activeSpeakers.find(
        (participant) => !participant.isLocal
      );
      if (remoteSpeaker) {
        setLastSpeakerIdentity(remoteSpeaker.identity);
      }

      syncParticipantState(room);
    };

    const handleParticipantChange = () => {
      syncParticipantState(room);
    };

    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
    room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
    room.on(RoomEvent.DataReceived, handleDataReceived);
    room.on(RoomEvent.ParticipantAttributesChanged, handleParticipantChange);
    room.on(RoomEvent.ParticipantConnected, handleParticipantChange);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantChange);
    room.on(RoomEvent.TrackSubscribed, handleParticipantChange);
    room.on(RoomEvent.TrackUnsubscribed, handleParticipantChange);

    syncParticipantState(room);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
      room.off(RoomEvent.DataReceived, handleDataReceived);
      room.off(RoomEvent.ParticipantAttributesChanged, handleParticipantChange);
      room.off(RoomEvent.ParticipantConnected, handleParticipantChange);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantChange);
      room.off(RoomEvent.TrackSubscribed, handleParticipantChange);
      room.off(RoomEvent.TrackUnsubscribed, handleParticipantChange);
    };
  }, [session, syncParticipantState]);

  useEffect(() => {
    if (!session) {
      return;
    }

    ignorePromise(
      session.room.localParticipant.setAttributes({
        callsign,
      })
    );
  }, [callsign, session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let cancelled = false;

    const syncBindings = async () => {
      const nextBindings = bindings.filter((binding) => binding.shortcut);

      await Promise.all(
        nextBindings.map(async (binding) => {
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
      const registeredBindings = bindings.filter((binding) => binding.shortcut);
      for (const binding of registeredBindings) {
        ignorePromise(unregister(binding.shortcut));
      }
    };
  }, [bindings, session, startWhisper, stopWhisper]);

  const connectToRoom = useCallback(
    async (payload: SessionResponse) => {
      const room = new Room();
      setStatus(`connecting ${payload.sessionCode}`);
      await room.connect(payload.livekitUrl, payload.token);
      await ensurePublishedMic(room);
      whisperStateRef.current = new Map();
      setLastSpeakerIdentity(null);
      setSession({ ...payload, room });
      setParticipants(deriveParticipants(room));
      await room.localParticipant.setAttributes({
        callsign: payload.displayName,
      });
      setStatus(`connected ${payload.sessionCode}`);
    },
    [ensurePublishedMic]
  );

  const handleCreateSession = useCallback(async () => {
    setIsBusy(true);
    setStatus("creating");

    try {
      const payload = await requestSession("/api/session/create", {
        displayName: callsign.trim(),
      });
      await navigator.clipboard.writeText(payload.sessionCode);
      await connectToRoom(payload);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "create failed");
    } finally {
      setIsBusy(false);
    }
  }, [callsign, connectToRoom]);

  const handleJoinSession = useCallback(async () => {
    setIsBusy(true);
    setStatus("joining");

    try {
      const payload = await requestSession("/api/session/join", {
        displayName: callsign.trim(),
        sessionCode: joinCode.trim().toLowerCase(),
      });
      await connectToRoom(payload);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "join failed");
    } finally {
      setIsBusy(false);
    }
  }, [callsign, connectToRoom, joinCode]);

  const disconnect = useCallback(async () => {
    const activeSession = session;
    if (activeSession) {
      await Promise.all(
        bindings
          .filter((binding) => binding.shortcut)
          .map((binding) => unregister(binding.shortcut).catch(() => undefined))
      );

      await micPublicationRef.current?.mute().catch(() => undefined);
      activeSession.room.disconnect();
    }

    micPublicationRef.current = null;
    whisperStateRef.current = new Map();
    setActiveShortcut(null);
    setLastSpeakerIdentity(null);
    setParticipants([]);
    setSession(null);
    setStatus("disconnected");
  }, [bindings, session]);

  const handleCallsignChange = useCallback(
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

  const handleNewGroupNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setNewGroupName(event.target.value);
    },
    []
  );

  const handleJoinClick = useCallback(() => {
    ignorePromise(handleJoinSession());
  }, [handleJoinSession]);

  const handleCreateClick = useCallback(() => {
    ignorePromise(handleCreateSession());
  }, [handleCreateSession]);

  const handleDisconnectClick = useCallback(() => {
    ignorePromise(disconnect());
  }, [disconnect]);

  const handleCopyCodeClick = useCallback(() => {
    if (!session) {
      return;
    }

    ignorePromise(navigator.clipboard.writeText(session.sessionCode));
  }, [session]);

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

  const handleAddGroup = useCallback(() => {
    const name = sanitizeGroupName(newGroupName);
    if (!name) {
      return;
    }

    setGroups((current) => [
      ...current,
      { id: globalThis.crypto.randomUUID(), name },
    ]);
    setNewGroupName("");
  }, [newGroupName]);

  const handleGroupNameChange = useCallback((id: string, value: string) => {
    setGroups((current) =>
      current.map((group) =>
        group.id === id
          ? { ...group, name: sanitizeGroupName(value) || group.name }
          : group
      )
    );
  }, []);

  const handleRemoveGroup = useCallback((id: string) => {
    setGroups((current) => current.filter((group) => group.id !== id));
    setBindings((current) =>
      current.map((binding) =>
        binding.target === `group:${id}`
          ? { ...binding, target: "all" }
          : binding
      )
    );
    setSessionAssignments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, value]) => [
          key,
          value.filter((candidate) => candidate !== id),
        ])
      )
    );
  }, []);

  const handleToggleParticipantGroup = useCallback(
    (participantIdentity: string, groupId: string) => {
      if (!session) {
        return;
      }

      const key = participantAssignmentKey(
        session.sessionCode,
        participantIdentity
      );
      setSessionAssignments((current) => {
        const currentGroups = current[key] ?? [];
        const nextGroups = currentGroups.includes(groupId)
          ? currentGroups.filter((candidate) => candidate !== groupId)
          : [...currentGroups, groupId];

        return {
          ...current,
          [key]: nextGroups,
        };
      });
    },
    [session]
  );

  const targetOptions = useMemo(() => {
    const options: BindingOption[] = [
      { label: "all", value: "all" },
      { label: "reply", value: "reply" },
    ];

    for (const group of groups) {
      options.push({
        label: `group:${group.name}`,
        value: `group:${group.id}`,
      });
    }

    for (const participant of participantRows) {
      if (participant.isLocal) {
        continue;
      }

      options.push({
        label: `user:${participant.displayName}`,
        value: `identity:${participant.identity}`,
      });
    }

    return options;
  }, [groups, participantRows]);

  const activeTargetLabel = useMemo(() => {
    const activeBinding = bindings.find(
      (binding) => binding.id === activeShortcut
    );
    if (!activeBinding) {
      return "idle";
    }

    return targetLabel(activeBinding.target, groups, participantRows);
  }, [activeShortcut, bindings, groups, participantRows]);

  const remoteParticipants = useMemo(
    () => participantRows.filter((participant) => !participant.isLocal),
    [participantRows]
  );

  const sessionPanel = session ? (
    <div className="grid gap-2">
      <div className="border px-2 py-2 text-xs">
        <div>{session.sessionCode}</div>
        <div className="text-muted-foreground">{session.identity}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          className="h-auto px-2 py-1 text-xs"
          onClick={handleCopyCodeClick}
          variant="outline"
        >
          copy code
        </Button>
        <Button
          className="h-auto px-2 py-1 text-xs"
          onClick={handleDisconnectClick}
        >
          disconnect
        </Button>
      </div>
    </div>
  ) : (
    <div className="grid gap-2">
      <input
        className="border px-2 py-1 text-xs"
        onChange={handleJoinCodeChange}
        placeholder="session code"
        value={joinCode}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          className="h-auto px-2 py-1 text-xs"
          disabled={
            isBusy ||
            joinCode.trim().length === 0 ||
            callsign.trim().length === 0
          }
          onClick={handleJoinClick}
        >
          {isBusy ? <LoaderCircle className="size-3 animate-spin" /> : "join"}
        </Button>
        <Button
          className="h-auto px-2 py-1 text-xs"
          disabled={isBusy || callsign.trim().length === 0}
          onClick={handleCreateClick}
          variant="outline"
        >
          {isBusy ? <LoaderCircle className="size-3 animate-spin" /> : "create"}
        </Button>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid max-w-6xl gap-3 px-3 py-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-3 border p-3">
          <div className="space-y-1">
            <div className="text-xs">LogiComms</div>
            <div className="text-[11px] text-muted-foreground">{status}</div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">nickname</div>
            <input
              className="w-full border px-2 py-1 text-xs"
              onChange={handleCallsignChange}
              value={callsign}
            />
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">session</div>
            {sessionPanel}
          </div>

          <div className="space-y-1 border-t pt-3">
            <div className="text-[11px] text-muted-foreground">state</div>
            <div className="text-xs">active target: {activeTargetLabel}</div>
            <div className="text-xs">
              last speaker: {lastSpeakerIdentity ?? "-"}
            </div>
            <div className="text-xs">
              participants: {participantRows.length}
            </div>
          </div>
        </aside>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3">
            <section className="space-y-2 border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs">bindings</div>
                <Button
                  className="h-auto px-2 py-1 text-xs"
                  onClick={handleAddBinding}
                  variant="outline"
                >
                  add
                </Button>
              </div>

              <div className="space-y-2">
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

            <section className="space-y-2 border p-3">
              <div className="text-xs">groups</div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_72px]">
                <input
                  className="border px-2 py-1 text-xs"
                  onChange={handleNewGroupNameChange}
                  value={newGroupName}
                />
                <Button
                  className="h-auto px-2 py-1 text-xs"
                  onClick={handleAddGroup}
                  variant="outline"
                >
                  add
                </Button>
              </div>

              <div className="space-y-2">
                {groups.map((group) => (
                  <GroupRow
                    group={group}
                    key={group.id}
                    onNameChange={handleGroupNameChange}
                    onRemove={handleRemoveGroup}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-2 border p-3">
              <div className="text-xs">participant group assignment</div>
              {session ? (
                <div className="space-y-2">
                  {remoteParticipants.map((participant) => (
                    <ParticipantAssignmentRow
                      groups={groups}
                      key={participant.id}
                      onToggleGroup={handleToggleParticipantGroup}
                      participant={participant}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  join a session to assign users
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-3">
            <section className="space-y-2 border p-3">
              <div className="text-xs">participants</div>
              <div className="space-y-2">
                {participantRows.length > 0 ? (
                  participantRows.map((participant) => (
                    <div
                      className="border px-2 py-2 text-xs"
                      key={participant.id}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate">
                          {participant.displayName}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {participant.isSpeaking ? "speaking" : ""}
                        </div>
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {participant.isLocal ? "you" : participant.identity}
                      </div>
                      {participant.assignedGroupIds.length > 0 ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {participant.assignedGroupIds
                            .map(
                              (groupId) =>
                                groups.find((group) => group.id === groupId)
                                  ?.name ?? groupId
                            )
                            .join(", ")}
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="text-[11px] text-muted-foreground">
                    no participants
                  </div>
                )}
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}

export const Component = HomePage;
