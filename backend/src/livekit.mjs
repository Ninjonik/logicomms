import {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import { config, requireLiveKitConfig } from "./config.mjs";

export function createRoomService() {
  requireLiveKitConfig();
  return new RoomServiceClient(
    config.livekitUrl,
    config.livekitApiKey,
    config.livekitApiSecret
  );
}

export async function createRoom(code) {
  const roomService = createRoomService();
  await roomService.createRoom({
    emptyTimeout: 60,
    maxParticipants: 64,
    name: code,
  });
}

export async function deleteRoom(code) {
  const roomService = createRoomService();
  await roomService.deleteRoom(code);
}

export async function getParticipantCount(code) {
  const roomService = createRoomService();
  const participants = await roomService.listParticipants(code);
  return participants.length;
}

export function buildParticipantToken({ identity, name, room }) {
  requireLiveKitConfig();

  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    name,
  });

  token.addGrant({
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    room,
    roomJoin: true,
  });

  return token.toJwt();
}

export function receiveWebhook(body, authorization) {
  requireLiveKitConfig();

  if (!authorization) {
    throw new Error("Missing LiveKit webhook authorization header.");
  }

  const receiver = new WebhookReceiver(
    config.livekitApiKey,
    config.livekitApiSecret
  );

  return receiver.receive(body, authorization);
}
