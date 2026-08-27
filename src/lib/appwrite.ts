import { Account, Channel, Client, Functions } from 'appwrite';

const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT ?? 'https://appwrite.igportals.eu/v1')
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID ?? 'logicomms');

const account = new Account(client);
const functions = new Functions(client);

const DATABASE_ID = 'logicomms';
const LOBBIES_TABLE_ID = 'lobbies';

export async function ensureAnonymousSession() {
  try {
    await account.get();
  } catch {
    await account.createAnonymousSession();
  }
}

export async function getCurrentUser() {
  return account.get();
}

export async function callLobbyApi<T>(body: Record<string, unknown>): Promise<T> {
  const execution = await functions.createExecution({
    functionId: 'api',
    body: JSON.stringify(body),
    async: false,
  });
  const response = JSON.parse(execution.responseBody) as { ok: boolean; data: T; error?: string };
  if (!response.ok) throw new Error(response.error ?? 'Lobby request failed.');
  return response.data;
}

// A lobby row changes whenever somebody joins, leaves, or sends a presence
// heartbeat. Subscribe to that one row, then obtain the authoritative member
// list through the existing API function.
export function subscribeToLobby(lobbyCode: string, onChange: () => void) {
  return client.subscribe(Channel.tablesdb(DATABASE_ID).table(LOBBIES_TABLE_ID).row(lobbyCode), onChange);
}
