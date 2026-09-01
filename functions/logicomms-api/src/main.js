import { Client, ID, Permission, Query, Role, TablesDB } from 'node-appwrite';
import { AccessToken } from 'livekit-server-sdk';

const DATABASE_ID = 'logicomms';
const LOBBIES_TABLE_ID = 'lobbies';
const MEMBERS_TABLE_ID = 'members';
// This only protects against an app crash that cannot send leaveLobby; normal
// joins and leaves are driven directly by Realtime events.
const STALE_MEMBER_AFTER_MS = 15_000;
const ADJECTIVES = ['amber', 'brisk', 'calm', 'cinder', 'clear', 'copper', 'crimson', 'distant', 'eager', 'frosty', 'golden', 'granite', 'hidden', 'iron', 'ivory', 'lunar', 'misty', 'noble', 'quiet', 'rapid', 'silver', 'solid', 'swift', 'violet'];
const NOUNS = ['anchor', 'badger', 'beacon', 'cedar', 'comet', 'falcon', 'forest', 'harbor', 'kestrel', 'lantern', 'maple', 'meadow', 'otter', 'pioneer', 'raven', 'ridge', 'summit', 'thistle', 'valley', 'willow', 'wolf', 'wren'];

const now = () => new Date().toISOString();
const normalizeCode = (value) => String(value ?? '').trim().toLowerCase();
const randomCode = () => `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
const lobbyReadPermissions = [Permission.read(Role.any())];

function lobbyCode(value) {
  const code = normalizeCode(value);
  if (!/^[a-z0-9]{3,32}$/.test(code)) throw new Error('Lobby names must be one word using 3–32 letters or numbers.');
  return code;
}

function requestBody(req) {
  if (!req.body) return {};
  try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { throw new Error('Request body must be valid JSON.'); }
}

function nickname(value) {
  const cleaned = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 32) throw new Error('Nickname must be between 1 and 32 characters.');
  return cleaned;
}

function userId(req) {
  const id = req.headers['x-appwrite-user-id'];
  if (!id) throw new Error('Sign in anonymously before using LogiComms.');
  return id;
}

function makeTables(req) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');
  return new TablesDB(client);
}

async function listMembers(tables, lobbyId) {
  const result = await tables.listRows({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, queries: [Query.equal('lobbyId', lobbyId), Query.limit(100)] });
  return result.rows;
}

async function getLobby(tables, lobbyId) {
  try { return await tables.getRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: lobbyId }); }
  catch (caught) { if (caught.code === 404) return null; throw caught; }
}

async function pruneLobby(tables, lobbyId) {
  const members = await listMembers(tables, lobbyId);
  const stale = members.filter((member) => Date.parse(member.lastSeenAt) < Date.now() - STALE_MEMBER_AFTER_MS);
  await Promise.all(stale.map((member) => tables.deleteRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: member.$id })));
  const remaining = members.filter((member) => !stale.includes(member));
  if (remaining.length === 0 && (await getLobby(tables, lobbyId))) await tables.deleteRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: lobbyId });
  // Member rows are private, so clients subscribe to the readable lobby row.
  // Touch it whenever pruning changes membership to publish that change.
  else if (stale.length > 0) await tables.updateRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: lobbyId, data: { lastActiveAt: now() }, permissions: lobbyReadPermissions });
  return remaining;
}

async function lobbyState(tables, lobbyId) {
  const lobby = await getLobby(tables, lobbyId);
  if (!lobby) return null;
  const members = await pruneLobby(tables, lobbyId);
  if (members.length === 0) return null;
  return { code: lobby.$id, ownerId: lobby.ownerId, roomName: lobby.roomName, members: members.map(({ $id, $createdAt, $updatedAt, $permissions, ...member }) => member) };
}

async function createLobby(tables, actorId, body) {
  const displayName = nickname(body.nickname);
  const requestedCode = normalizeCode(body.code);
  if (requestedCode) {
    const code = lobbyCode(requestedCode);
    if (await getLobby(tables, code)) throw new Error('That lobby name is already taken.');
    const timestamp = now();
    try {
      await tables.createRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: code, data: { ownerId: actorId, roomName: code, lastActiveAt: timestamp }, permissions: lobbyReadPermissions });
    } catch (caught) {
      if (caught.code === 409) throw new Error('That lobby name is already taken.');
      throw caught;
    }
    await tables.createRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: ID.unique(), data: { lobbyId: code, userId: actorId, nickname: displayName, livekitIdentity: `u_${actorId}`, lastSeenAt: timestamp } });
    return lobbyState(tables, code);
  }

  let code;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = randomCode();
    if (!(await getLobby(tables, candidate))) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not reserve a lobby name. Please try again.');
  const timestamp = now();
  await tables.createRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: code, data: { ownerId: actorId, roomName: code, lastActiveAt: timestamp }, permissions: lobbyReadPermissions });
  await tables.createRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: ID.unique(), data: { lobbyId: code, userId: actorId, nickname: displayName, livekitIdentity: `u_${actorId}`, lastSeenAt: timestamp } });
  return lobbyState(tables, code);
}

async function joinLobby(tables, actorId, body) {
  const code = lobbyCode(body.code);
  const displayName = nickname(body.nickname);
  if (!code) throw new Error('Enter a lobby name.');
  if (!(await getLobby(tables, code))) throw new Error('That lobby no longer exists.');
  const existing = (await listMembers(tables, code)).find((member) => member.userId === actorId);
  const data = { lobbyId: code, userId: actorId, nickname: displayName, livekitIdentity: `u_${actorId}`, lastSeenAt: now() };
  if (existing) await tables.updateRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: existing.$id, data });
  else await tables.createRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: ID.unique(), data });
  await tables.updateRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: code, data: { lastActiveAt: now() }, permissions: lobbyReadPermissions });
  return lobbyState(tables, code);
}

async function leaveLobby(tables, actorId, body) {
  const code = lobbyCode(body.code);
  const members = await listMembers(tables, code);
  await Promise.all(members.filter((member) => member.userId === actorId).map((member) => tables.deleteRow({ databaseId: DATABASE_ID, tableId: MEMBERS_TABLE_ID, rowId: member.$id })));
  if ((await listMembers(tables, code)).length === 0 && (await getLobby(tables, code))) await tables.deleteRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: code });
  // Publishing a lobby update makes a normal leave visible to every client
  // immediately; previously only the deleted private member row changed.
  else if (await getLobby(tables, code)) await tables.updateRow({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, rowId: code, data: { lastActiveAt: now() }, permissions: lobbyReadPermissions });
  return { code, left: true };
}

async function issueLiveKitToken(tables, actorId, body) {
  const code = lobbyCode(body.code);
  const member = (await listMembers(tables, code)).find((entry) => entry.userId === actorId);
  if (!member) throw new Error('Join the lobby before connecting voice.');
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) throw new Error('Voice server is not configured.');
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: member.livekitIdentity,
    name: member.nickname,
    ttl: '2h',
    metadata: JSON.stringify({ lobby: code, userId: actorId }),
  });
  token.addGrant({ roomJoin: true, room: `logicomms-${code}`, canPublish: true, canSubscribe: true, canPublishData: true });
  return { url: process.env.LIVEKIT_URL, room: `logicomms-${code}`, token: await token.toJwt(), expiresInSeconds: 7200 };
}

async function cleanupExpiredLobbies(tables) {
  let cursor;
  let removed = 0;
  do {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await tables.listRows({ databaseId: DATABASE_ID, tableId: LOBBIES_TABLE_ID, queries });
    for (const lobby of page.rows) {
      const members = await pruneLobby(tables, lobby.$id);
      if (members.length === 0) removed += 1;
    }
    cursor = page.rows.at(-1)?.$id;
    if (page.rows.length < 100) cursor = undefined;
  } while (cursor);
  return { removed };
}

export default async ({ req, res, error }) => {
  try {
    const body = requestBody(req);
    const tables = makeTables(req);
    if (!body.action && !req.headers['x-appwrite-user-id']) return res.json({ ok: true, data: await cleanupExpiredLobbies(tables) });
    const actorId = userId(req);
    let data;
    if (body.action === 'createLobby') data = await createLobby(tables, actorId, body);
    else if (body.action === 'joinLobby' || body.action === 'heartbeat') data = await joinLobby(tables, actorId, body);
    else if (body.action === 'leaveLobby') data = await leaveLobby(tables, actorId, body);
    else if (body.action === 'getLobby') data = await lobbyState(tables, normalizeCode(body.code));
    else if (body.action === 'livekitToken') data = await issueLiveKitToken(tables, actorId, body);
    else throw new Error('Unknown action.');
    return res.json({ ok: true, data });
  } catch (caught) {
    error(caught.stack ?? caught.message);
    return res.json({ ok: false, error: caught.message ?? 'Request failed.' }, 400);
  }
};
