import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';

const app = express();
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const branch = process.env.GITHUB_WEBHOOK_BRANCH ?? 'refs/heads/main';
const script = process.env.DEPLOY_SCRIPT ?? '/home/services/logicomms/ops/deploy.sh';
let running = false;

app.use(express.json({ verify: (request, _response, body) => { request.rawBody = body; } }));

function valid(request) {
  const signature = request.header('x-hub-signature-256');
  if (!secret || !signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(request.rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.get('/health', (_request, response) => response.json({ ok: true, running }));
app.post('/github-webhook', (request, response) => {
  if (!valid(request)) return response.status(401).json({ error: 'Invalid signature.' });
  if (request.header('x-github-event') === 'ping') return response.json({ ok: true, pong: true });
  if (request.header('x-github-event') !== 'push' || request.body?.ref !== branch) return response.json({ ignored: true });
  if (running) return response.status(409).json({ error: 'A release build is already running.' });
  running = true;
  const build = spawn('bash', [script], { stdio: 'inherit', env: process.env });
  build.on('exit', () => { running = false; });
  return response.status(202).json({ accepted: true });
});

app.listen(Number(process.env.WEBHOOK_PORT ?? 3010));
