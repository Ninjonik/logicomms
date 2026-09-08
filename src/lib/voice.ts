import { Room, RoomEvent, Track } from 'livekit-client';
import type { LocalTrackPublication, RemoteAudioTrack } from 'livekit-client';

export type VoiceCredentials = { url: string; token: string };
export type VoiceRoute = { id: string; targets: string[] };
const TARGET_TRACK_PREFIX = 'logicomms:to:';

export class VoiceConnection {
  readonly room = new Room({ adaptiveStream: true, dynacast: true });
  // Each recipient gets their own publication. A recipient's client only
  // attaches publications addressed to its own identity, so playback no
  // longer depends on a separate, racy route-control data message.
  private publications = new Map<string, LocalTrackPublication>();
  private pendingPublications = new Map<string, Promise<LocalTrackPublication | undefined>>();
  private routes = new Map<string, VoiceRoute>();
  private source?: MediaStreamTrack;
  private processedSource?: MediaStreamTrack;
  private audioContext?: AudioContext;
  private inputGain?: GainNode;
  private remoteTracks = new Map<string, RemoteAudioTrack>();
  private remoteElements = new Map<string, HTMLAudioElement>();
  private remoteTrackOwners = new Map<string, string>();
  private remoteAudioContext?: AudioContext;
  private participantVolumes = new Map<string, number>();
  private incomingTracksBySender = new Map<string, Set<string>>();
  private activeTargets = new Map<string, Set<string>>();
  private targetActiveCounts = new Map<string, number>();
  // Publication and microphone setup are async. Serialize both configuration
  // and PTT transitions so a fast key press cannot race track creation or a
  // matching key release.
  private configurationQueue: Promise<void> = Promise.resolve();
  private transmissionQueue: Promise<void> = Promise.resolve();
  private lastCaller?: string;
  private inputDeviceId = 'default';
  private outputDeviceId = 'default';
  private outputVolume = 1;

  constructor(
    onState: (state: string) => void,
    private readonly onIncomingActivity: (identity: string, active: boolean) => void = () => undefined,
    private readonly onReplyTarget: (identity?: string) => void = () => undefined,
  ) {
    this.room.on(RoomEvent.ConnectionStateChanged, (state) => onState(`Voice: ${state}`));
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (!this.isAddressedToMe(publication.trackName)) return;
      const audio = track as RemoteAudioTrack;
      void audio.setSinkId(this.outputDeviceId).catch(() => undefined);
      this.remoteAudioContext ??= new AudioContext();
      audio.setAudioContext(this.remoteAudioContext);
      const element = audio.attach(); element.autoplay = true; element.style.display = 'none'; document.body.append(element);
      this.remoteElements.set(publication.trackSid, element);
      this.remoteTracks.set(publication.trackSid, audio);
      this.remoteTrackOwners.set(publication.trackSid, participant.identity);
      this.applyTrackVolume(publication.trackSid);
      this.setIncomingTrackActivity(participant.identity, publication.trackSid, !publication.isMuted);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      (track as RemoteAudioTrack).detach().forEach((element) => element.remove());
      this.remoteTracks.delete(publication.trackSid); this.remoteElements.delete(publication.trackSid); this.remoteTrackOwners.delete(publication.trackSid);
      this.setIncomingTrackActivity(participant.identity, publication.trackSid, false);
    });
    this.room.on(RoomEvent.TrackMuted, (publication, participant) => {
      if (publication.kind === Track.Kind.Audio && this.isAddressedToMe(publication.trackName)) this.setIncomingTrackActivity(participant.identity, publication.trackSid, false);
    });
    this.room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (publication.kind === Track.Kind.Audio && this.isAddressedToMe(publication.trackName)) this.setIncomingTrackActivity(participant.identity, publication.trackSid, true);
    });
    this.room.on(RoomEvent.Disconnected, () => onState('Voice disconnected'));
  }

  async connect(credentials: VoiceCredentials) {
    // Media always goes through the LiveKit SFU; this is not peer-to-peer.
    // Do not force `relay` here: it makes Firefox reject an IPv4 TURN server
    // when the client has an IPv6 local interface. TURN remains available as
    // a normal fallback, while the public SFU candidate works everywhere.
    await this.room.connect(credentials.url, credentials.token);
  }

  async configure(routes: VoiceRoute[], inputDeviceId = 'default') {
    const configuration = this.configurationQueue
      .catch(() => undefined)
      .then(() => this.configureNow(routes, inputDeviceId));
    this.configurationQueue = configuration;
    await configuration;
  }

  private async configureNow(routes: VoiceRoute[], inputDeviceId: string) {
    if (this.source && this.inputDeviceId !== inputDeviceId) {
      await Promise.all([...this.publications.values()].map((publication) => publication.track ? this.room.localParticipant.unpublishTrack(publication.track) : Promise.resolve(undefined)));
      this.publications.clear(); this.activeTargets.clear(); this.targetActiveCounts.clear(); this.source.stop(); this.processedSource?.stop(); this.audioContext?.close().catch(() => undefined); this.source = undefined; this.processedSource = undefined; this.audioContext = undefined; this.inputGain = undefined;
    }
    this.inputDeviceId = inputDeviceId;
    this.routes = new Map(routes.map((route) => [route.id, route]));
    if (!this.source && routes.length) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: inputDeviceId === 'default' ? undefined : { exact: inputDeviceId } } });
      this.source = stream.getAudioTracks()[0];
      this.audioContext = new AudioContext();
      const sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.inputGain = this.audioContext.createGain();
      const destination = this.audioContext.createMediaStreamDestination();
      sourceNode.connect(this.inputGain).connect(destination);
      this.processedSource = destination.stream.getAudioTracks()[0];
    }
    const targets = new Set(routes.flatMap((route) => route.targets));
    for (const target of targets) {
      const publication = await this.ensurePublication(target);
      if (!publication) continue;
      if ((this.targetActiveCounts.get(target) ?? 0) > 0) await publication.unmute();
    }
  }

  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId;
    const context = this.remoteAudioContext as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> } | undefined;
    await context?.setSinkId?.(deviceId).catch(() => undefined);
    await Promise.all([...this.remoteTracks.values()].map((track) => track.setSinkId(deviceId).catch(() => undefined)));
  }

  setInputVolume(volume: number) {
    if (this.inputGain) this.inputGain.gain.value = Math.max(0, Math.min(2, volume));
  }

  setOutputVolume(volume: number) {
    this.outputVolume = Math.max(0, Math.min(1, volume));
    this.remoteTracks.forEach((_track, sid) => this.applyTrackVolume(sid));
  }

  setParticipantVolume(identity: string, volume: number) {
    this.participantVolumes.set(identity, Math.max(0, Math.min(2, volume)));
    this.remoteTrackOwners.forEach((owner, sid) => {
      if (owner === identity) this.applyTrackVolume(sid);
    });
  }

  private applyTrackVolume(sid: string) {
    const track = this.remoteTracks.get(sid);
    if (!track) return;
    const owner = this.remoteTrackOwners.get(sid);
    track.setVolume(this.outputVolume * (owner ? this.participantVolumes.get(owner) ?? 1 : 1));
  }

  async setTransmitting(routeId: string, active: boolean, replyTarget?: string) {
    const transition = this.transmissionQueue
      .catch(() => undefined)
      .then(async () => {
        const currentTargets = this.activeTargets.get(routeId);
        if (active) {
          // A repeated key-down must not increment the same recipients twice.
          if (currentTargets) return;
          const route = this.routes.get(routeId);
          const recipient = replyTarget ?? this.lastCaller;
          const targets = new Set(routeId === 'reply' ? (recipient ? [recipient] : []) : route?.targets ?? []);
          if (!targets.size) return;
          this.activeTargets.set(routeId, targets);
          for (const target of targets) await this.changeTargetActivity(target, 1);
          return;
        }

        if (!currentTargets) return;
        for (const target of currentTargets) await this.changeTargetActivity(target, -1);
        this.activeTargets.delete(routeId);
      });
    this.transmissionQueue = transition;
    await transition;
  }

  private async changeTargetActivity(target: string, delta: 1 | -1) {
    const current = this.targetActiveCounts.get(target) ?? 0;
    const next = Math.max(0, current + delta);
    if (next === 0) this.targetActiveCounts.delete(target); else this.targetActiveCounts.set(target, next);
    const publication = this.publications.get(target) ?? (next > 0 ? await this.ensurePublication(target) : undefined);
    if (!publication || current === next) return;
    if (current === 0 && next > 0) await publication.unmute();
    else if (current > 0 && next === 0) await publication.mute();
  }

  private isAddressedToMe(trackName: string) {
    return trackName === `${TARGET_TRACK_PREFIX}${this.room.localParticipant.identity}`;
  }

  private async ensurePublication(target: string) {
    const existing = this.publications.get(target);
    if (existing) return existing;
    const pending = this.pendingPublications.get(target);
    if (pending) return pending;
    if (!this.source) return undefined;
    const creation = (async () => {
      const publication = await this.room.localParticipant.publishTrack(
        (this.processedSource ?? this.source!).clone(),
        { name: `${TARGET_TRACK_PREFIX}${target}` },
      );
      this.publications.set(target, publication);
      await publication.mute();
      return publication;
    })();
    this.pendingPublications.set(target, creation);
    try { return await creation; }
    finally { this.pendingPublications.delete(target); }
  }

  private setIncomingTrackActivity(sender: string, sid: string, active: boolean) {
    const tracks = this.incomingTracksBySender.get(sender) ?? new Set<string>();
    if (active) {
      tracks.add(sid);
      this.lastCaller = sender;
      this.onReplyTarget(sender);
    } else tracks.delete(sid);
    if (tracks.size) this.incomingTracksBySender.set(sender, tracks); else this.incomingTracksBySender.delete(sender);
    this.onIncomingActivity(sender, tracks.size > 0);
  }

  disconnect() { this.source?.stop(); this.processedSource?.stop(); void this.audioContext?.close(); void this.remoteAudioContext?.close(); this.room.disconnect(); }
}
