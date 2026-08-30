import { Room, RoomEvent, Track } from 'livekit-client';
import type { LocalTrackPublication, RemoteAudioTrack, RemoteParticipant } from 'livekit-client';

export type VoiceCredentials = { url: string; token: string };
export type VoiceRoute = { id: string; targets: string[] };
type RouteSignal = { type: 'start' | 'stop'; trackSid: string; targets: string[] };

export class VoiceConnection {
  readonly room = new Room({ adaptiveStream: true, dynacast: true });
  private publications = new Map<string, LocalTrackPublication>();
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
  private activeBySender = new Map<string, Set<string>>();
  private selectedBySender = new Map<string, string>();
  private routeByTrack = new Map<string, { sender: string; targeted: boolean }>();
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
    this.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== 'logicomms.route' || !participant) return;
      try { this.applySignal(participant, JSON.parse(new TextDecoder().decode(payload)) as RouteSignal); } catch { /* Ignore foreign data. */ }
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const audio = track as RemoteAudioTrack;
      audio.setMuted(true);
      void audio.setSinkId(this.outputDeviceId).catch(() => undefined);
      this.remoteAudioContext ??= new AudioContext();
      audio.setAudioContext(this.remoteAudioContext);
      const element = audio.attach(); element.autoplay = true; element.style.display = 'none'; document.body.append(element);
      this.remoteElements.set(publication.trackSid, element);
      this.remoteTracks.set(publication.trackSid, audio);
      this.remoteTrackOwners.set(publication.trackSid, participant.identity);
      this.applyTrackVolume(publication.trackSid);
      this.refreshSender(participant.identity);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      (track as RemoteAudioTrack).detach().forEach((element) => element.remove());
      this.remoteTracks.delete(publication.trackSid); this.remoteElements.delete(publication.trackSid); this.remoteTrackOwners.delete(publication.trackSid); this.routeByTrack.delete(publication.trackSid); this.refreshSender(participant.identity);
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
    if (this.source && this.inputDeviceId !== inputDeviceId) {
      await Promise.all([...this.publications.values()].map((publication) => publication.track ? this.room.localParticipant.unpublishTrack(publication.track) : Promise.resolve(undefined)));
      this.publications.clear(); this.source.stop(); this.processedSource?.stop(); this.audioContext?.close().catch(() => undefined); this.source = undefined; this.processedSource = undefined; this.audioContext = undefined; this.inputGain = undefined;
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
    for (const route of routes) {
      if (this.publications.has(route.id) || !this.source) continue;
      const publication = await this.room.localParticipant.publishTrack((this.processedSource ?? this.source).clone(), { name: `logicomms:${route.id}` });
      await publication.mute();
      this.publications.set(route.id, publication);
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
    const publication = this.publications.get(routeId);
    if (!publication) return;
    const route = this.routes.get(routeId);
    const recipient = replyTarget ?? this.lastCaller;
    const targets = routeId === 'reply' ? (recipient ? [recipient] : []) : route?.targets ?? [];
    if (!targets.length) return;
    if (active) await publication.unmute(); else await publication.mute();
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: active ? 'start' : 'stop', trackSid: publication.trackSid, targets } satisfies RouteSignal)), { reliable: true, topic: 'logicomms.route' });
  }

  private applySignal(participant: RemoteParticipant, signal: RouteSignal) {
    const targeted = signal.targets.includes(this.room.localParticipant.identity);
    this.routeByTrack.set(signal.trackSid, { sender: participant.identity, targeted });
    const active = this.activeBySender.get(participant.identity) ?? new Set<string>();
    if (signal.type === 'start' && targeted) {
      active.add(signal.trackSid);
      this.lastCaller = participant.identity;
      this.onReplyTarget(participant.identity);
    }
    else active.delete(signal.trackSid);
    this.activeBySender.set(participant.identity, active); this.refreshSender(participant.identity);
    this.onIncomingActivity(participant.identity, active.size > 0);
  }

  private refreshSender(sender: string) {
    const active = this.activeBySender.get(sender) ?? new Set<string>();
    let selected = this.selectedBySender.get(sender);
    if (!selected || !active.has(selected) || !this.remoteTracks.has(selected)) selected = [...active].find((sid) => this.remoteTracks.has(sid));
    if (selected) this.selectedBySender.set(sender, selected); else this.selectedBySender.delete(sender);
    for (const [sid, audio] of this.remoteTracks) if (this.routeByTrack.get(sid)?.sender === sender) audio.setMuted(sid !== selected);
  }

  disconnect() { this.source?.stop(); this.processedSource?.stop(); void this.audioContext?.close(); void this.remoteAudioContext?.close(); this.room.disconnect(); }
}
