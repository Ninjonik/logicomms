import "dotenv/config";
import path from "node:path";

const backendRoot = path.resolve(import.meta.dirname, "..");

export const config = {
  apiPort: Number(process.env.PORT ?? 3000),
  dbPath:
    process.env.LOGICOMMS_DB_PATH ?? path.join(backendRoot, "logicomms.sqlite"),
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitWebhookSecret: process.env.LIVEKIT_WEBHOOK_SECRET ?? "",
  releaseBaseUrl:
    process.env.LOGICOMMS_RELEASE_BASE_URL ??
    "https://logicomms.igportals.eu/downloads",
  releaseManifestPath:
    process.env.LOGICOMMS_RELEASE_MANIFEST_PATH ??
    path.join(backendRoot, "releases", "latest.json"),
};

export function requireLiveKitConfig() {
  if (!(config.livekitApiKey && config.livekitApiSecret && config.livekitUrl)) {
    throw new Error(
      "Missing LiveKit configuration. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL."
    );
  }
}
