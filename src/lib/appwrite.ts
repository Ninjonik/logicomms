import { Account, Client, Functions } from 'appwrite';

const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT ?? 'https://appwrite.igportals.eu/v1')
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID ?? 'logicomms');

const account = new Account(client);
const functions = new Functions(client);

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
