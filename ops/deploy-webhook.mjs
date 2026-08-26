import { spawn } from "node:child_process";
import crypto from "node:crypto";
import express from "express";

const app = express();
const port = Number(process.env.WEBHOOK_PORT ?? 3010);
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const branchRef = process.env.GITHUB_WEBHOOK_BRANCH ?? "refs/heads/main";
const deployScript =
  process.env.DEPLOY_SCRIPT ?? "/home/services/logicomms/ops/deploy.sh";

app.use(
  express.json({
    verify(request, _response, buffer) {
      request.rawBody = buffer;
    },
  })
);

function isValidSignature(request) {
  if (!secret) {
    return true;
  }

  const signature = request.header("x-hub-signature-256");
  if (!signature) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(request.rawBody)
    .digest("hex")}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

let activeDeployment = null;

app.post("/github-webhook", (request, response) => {
  if (!isValidSignature(request)) {
    response.status(401).json({ error: "Invalid signature." });
    return;
  }

  const event = request.header("x-github-event");
  if (event === "ping") {
    response.json({ ok: true, pong: true });
    return;
  }

  if (event !== "push") {
    response.json({ ignored: true });
    return;
  }

  if (request.body?.ref !== branchRef) {
    response.json({ ignored: true, reason: "branch_mismatch" });
    return;
  }

  if (activeDeployment) {
    response.status(409).json({ error: "Deployment already running." });
    return;
  }

  activeDeployment = spawn("bash", [deployScript], {
    env: process.env,
    stdio: "inherit",
  });

  activeDeployment.on("exit", () => {
    activeDeployment = null;
  });

  response.status(202).json({ accepted: true });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.listen(port, () => {
  console.log(`LogiComms deploy webhook listening on ${port}`);
});
