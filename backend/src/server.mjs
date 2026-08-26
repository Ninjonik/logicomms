import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { v4 as uuid } from "uuid";
import { config } from "./config.mjs";
import {
  createSession,
  deleteSessionByCode,
  getSessionByCode,
  incrementParticipantCount,
  listUsedCodes,
  setParticipantCount,
} from "./db.mjs";
import {
  buildParticipantToken,
  createRoom,
  deleteRoom,
  getParticipantCount,
  receiveWebhook,
} from "./livekit.mjs";
import { pickUnusedWord } from "./word-pool.mjs";

const app = express();
const releaseManifestDirectory = config.releaseManifestPath
  ? path.dirname(config.releaseManifestPath)
  : null;

app.use(cors());
app.use(express.json());
if (releaseManifestDirectory) {
  app.use("/downloads", express.static(releaseManifestDirectory));
}

function randomIdentity(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeDisplayName(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized.slice(0, 32) : fallback;
}

function buildSessionPayload(sessionCode, token, identity, displayName) {
  return {
    displayName,
    identity,
    livekitUrl: config.livekitUrl,
    sessionCode,
    token,
  };
}

function readReleaseManifest() {
  try {
    const payload = fs.readFileSync(config.releaseManifestPath, "utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function compareVersions(left, right) {
  const normalize = (value) =>
    String(value)
      .split("+")[0]
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const leftParts = normalize(left);
  const rightParts = normalize(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function buildDynamicManifest(manifest, target, arch) {
  const platformKey = `${target}-${arch}`;
  const platform = manifest?.platforms?.[platformKey];

  if (!(manifest?.version && platform?.url && platform?.signature)) {
    return null;
  }

  return {
    notes: manifest.notes ?? "",
    platforms: {
      [platformKey]: {
        signature: platform.signature,
        url: platform.url,
      },
    },
    pub_date: manifest.pub_date ?? new Date().toISOString(),
    version: manifest.version,
  };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/version", (_request, response) => {
  const manifest = readReleaseManifest();

  response.json({
    releaseBaseUrl: config.releaseBaseUrl,
    updater: manifest,
  });
});

app.get("/api/updates/latest.json", (_request, response) => {
  const manifest = readReleaseManifest();
  if (!manifest) {
    response.status(404).json({ error: "No release manifest available." });
    return;
  }

  response.json(manifest);
});

app.get("/api/updates/:target/:arch/:currentVersion", (request, response) => {
  const manifest = readReleaseManifest();
  if (!manifest) {
    response.status(404).json({ error: "No release manifest available." });
    return;
  }

  const { arch, currentVersion, target } = request.params;
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    response.status(204).end();
    return;
  }

  const dynamicManifest = buildDynamicManifest(manifest, target, arch);
  if (!dynamicManifest) {
    response.status(404).json({ error: "No matching platform artifact." });
    return;
  }

  response.json(dynamicManifest);
});

app.post("/api/session/create", async (_request, response) => {
  try {
    const code = pickUnusedWord(listUsedCodes());
    const identity = randomIdentity("host");
    const displayName = sanitizeDisplayName(
      _request.body?.displayName,
      `Host ${code}`
    );
    await createRoom(code);

    createSession({
      code,
      id: uuid(),
      participant_count: 1,
    });

    const token = await buildParticipantToken({
      identity,
      name: displayName,
      room: code,
    });

    response
      .status(201)
      .json(buildSessionPayload(code, token, identity, displayName));
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to create session.",
    });
  }
});

app.post("/api/session/join", async (request, response) => {
  const sessionCode = String(request.body?.sessionCode ?? "")
    .trim()
    .toLowerCase();

  if (!sessionCode) {
    response.status(400).json({ error: "Session code is required." });
    return;
  }

  const session = getSessionByCode(sessionCode);
  if (!session) {
    response.status(404).json({ error: "Session not found." });
    return;
  }

  try {
    const identity = randomIdentity("pilot");
    const displayName = sanitizeDisplayName(
      request.body?.displayName,
      `Operator ${sessionCode}`
    );
    const participantCount = await getParticipantCount(sessionCode);
    if (participantCount === 0) {
      deleteSessionByCode(sessionCode);
      response.status(404).json({ error: "Session is no longer active." });
      return;
    }

    incrementParticipantCount(sessionCode);

    const token = await buildParticipantToken({
      identity,
      name: displayName,
      room: sessionCode,
    });

    response.json(
      buildSessionPayload(sessionCode, token, identity, displayName)
    );
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to join session.",
    });
  }
});

app.post(
  "/api/webhooks/livekit",
  express.text({ type: "*/*" }),
  async (request, response) => {
    try {
      const event = await receiveWebhook(
        request.body,
        request.header("authorization") ?? undefined
      );

      const roomName = event.room?.name;
      if (!roomName) {
        response.status(200).json({ ok: true });
        return;
      }

      if (event.event === "participant_joined") {
        const participantCount = await getParticipantCount(roomName);
        setParticipantCount(roomName, participantCount);
      }

      if (event.event === "participant_left") {
        const participantCount = await getParticipantCount(roomName);
        if (participantCount === 0) {
          deleteSessionByCode(roomName);
          await deleteRoom(roomName);
        } else {
          setParticipantCount(roomName, participantCount);
        }
      }

      if (event.event === "room_finished") {
        deleteSessionByCode(roomName);
      }

      response.status(200).json({ ok: true });
    } catch (error) {
      response.status(400).json({
        error:
          error instanceof Error ? error.message : "Webhook handling failed.",
      });
    }
  }
);

app.listen(config.apiPort, () => {
  console.log(
    `LogiComms backend listening on http://localhost:${config.apiPort}`
  );
});
