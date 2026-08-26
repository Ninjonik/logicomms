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
  private remoteTracks = new Map<string, RemoteAudioTrack>();
  private activeBySender = new Map<string, Set<string>>();
  private selectedBySender = new Map<string, string>();
  private routeByTrack = new Map<string, { sender: string; targeted: boolean }>();
  private lastCaller?: string;
  private inputDeviceId = 'default';
  private outputDeviceId = 'default';

  constructor(
    onState: (state: string) => void,
    private readonly onIncomingActivity: (identity: string, active: boolean) => void = () => undefined,
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
      const element = audio.attach(); element.autoplay = true; element.style.display = 'none'; document.body.append(element);
      this.remoteTracks.set(publication.trackSid, audio);
      this.refreshSender(participant.identity);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      (track as RemoteAudioTrack).detach().forEach((element) => element.remove());
      this.remoteTracks.delete(publication.trackSid); this.routeByTrack.delete(publication.trackSid); this.refreshSender(participant.identity);
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
      this.publications.clear(); this.source.stop(); this.source = undefined;
    }
    this.inputDeviceId = inputDeviceId;
    this.routes = new Map(routes.map((route) => [route.id, route]));
    if (!this.source && routes.length) this.source = (await navigator.mediaDevices.getUserMedia({ audio: { deviceId: inputDeviceId === 'default' ? undefined : { exact: inputDeviceId } } })).getAudioTracks()[0];
    for (const route of routes) {
      if (this.publications.has(route.id) || !this.source) continue;
      const publication = await this.room.localParticipant.publishTrack(this.source.clone(), { name: `logicomms:${route.id}` });
      await publication.mute();
      this.publications.set(route.id, publication);
    }
  }

  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId;
    await Promise.all([...this.remoteTracks.values()].map((track) => track.setSinkId(deviceId).catch(() => undefined)));
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
    if (signal.type === 'start' && targeted) { active.add(signal.trackSid); this.lastCaller = participant.identity; }
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

  disconnect() { this.source?.stop(); this.room.disconnect(); }
}
