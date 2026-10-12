'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { hashPreviewPassword, verifyPreviewPassword, isValidPreviewPasswordHash } = require('../lib/preview-auth');

const TEST_PASSWORD = 'UnitTest-Preview-Password-92!';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function sessionCookie(response, fallback = '') {
  let headers = [];
  if (typeof response.headers.getSetCookie === 'function') headers = response.headers.getSetCookie();
  else if (response.headers.get('set-cookie')) headers = [response.headers.get('set-cookie')];
  const all = headers.join(',');
  const matches = [...all.matchAll(/menswear\.sid=([^;,]*)/g)].map((match) => match[1]);
  const usable = matches.filter((value) => value !== '');
  return usable.length ? `menswear.sid=${usable[usable.length - 1]}` : fallback;
}

function readCsrf(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  assert.ok(match, 'expected a CSRF token in the form');
  return match[1];
}

async function waitForServer(baseUrl, child, getLogs) {
  const deadline = Date.now() + 12_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready. Logs:\n${getLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200 && (await response.text()) === 'ok') return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${lastError?.message || 'timeout'}. Logs:\n${getLogs()}`);
}

test('preview password hashes are salted, valid, and verified safely', async () => {
  const first = await hashPreviewPassword(TEST_PASSWORD);
  const second = await hashPreviewPassword(TEST_PASSWORD);
  assert.notEqual(first, second, 'separate hashes should use separate salts');
  assert.equal(isValidPreviewPasswordHash(first), true);
  assert.equal(await verifyPreviewPassword(TEST_PASSWORD, first), true);
  assert.equal(await verifyPreviewPassword('incorrect preview password', first), false);
  assert.equal(isValidPreviewPasswordHash('sha256$bad'), false);
});


test('production startup fails closed when preview configuration is missing or disabled', () => {
  const projectRoot = path.join(__dirname, '..');
  const commonEnv = {
    ...process.env,
    NODE_ENV: 'production',
    SESSION_SECRET: 'test-only-production-session-secret-long-enough-001',
    PORT: '3000'
  };
  const missingHash = spawnSync(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...commonEnv, PREVIEW_GATE_ENABLED: 'true', PREVIEW_PASSWORD_HASH: '' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(missingHash.status, 1);
  assert.match(missingHash.stderr, /requires a valid PREVIEW_PASSWORD_HASH/i);

  const disabledGate = spawnSync(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...commonEnv, PREVIEW_GATE_ENABLED: 'false', ALLOW_PUBLIC_PRODUCTION: 'false' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(disabledGate.status, 1);
  assert.match(disabledGate.stderr, /Production startup blocked/i);
});

test('private preview gate protects pages, static assets, uploads, APIs, and the sitemap', async (t) => {
  const projectRoot = path.join(__dirname, '..');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'menswear-preview-gate-'));
  const uploadDir = path.join(dataDir, 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, 'private-sentinel.txt'), 'protected-upload-sentinel');
  const port = await freePort();
  const passwordHash = await hashPreviewPassword(TEST_PASSWORD);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    SESSION_SECRET: 'test-only-session-secret-that-is-long-enough-001',
    PREVIEW_GATE_ENABLED: 'true',
    PREVIEW_PASSWORD_HASH: passwordHash,
    MENSWEAR_DATA_DIR: dataDir,
    MENSWEAR_UPLOAD_DIR: uploadDir
  };
  delete env.ALLOW_PUBLIC_PRODUCTION;
  const child = spawn(process.execPath, ['server.js'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => logs);

  const health = await fetch(`${baseUrl}/healthz`, { redirect: 'manual' });
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const robots = await fetch(`${baseUrl}/robots.txt`, { redirect: 'manual' });
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \/\s*$/);

  for (const protectedPath of [
    '/', '/about', '/collections', '/suiting', '/tailoring', '/gallery', '/contact',
    '/css/site.css', '/js/site.js', '/uploads/private-sentinel.txt',
    '/api/appointment-availability?date=2026-12-01', '/sitemap.xml', '/admin/dashboard'
  ]) {
    const response = await fetch(`${baseUrl}${protectedPath}`, { redirect: 'manual' });
    assert.equal(response.status, 302, `${protectedPath} should redirect to the preview gate`);
    assert.match(response.headers.get('location') || '', /^\/_preview\?returnTo=/, `${protectedPath} should preserve an internal return path`);
  }

  const loginPage = await fetch(`${baseUrl}/_preview?returnTo=%2Fsuiting`, { redirect: 'manual' });
  assert.equal(loginPage.status, 200);
  let cookie = sessionCookie(loginPage);
  let html = await loginPage.text();
  assert.match(html, /Private Website Preview/);
  assert.doesNotMatch(html, /Hingu Cloth Store|premium men.s fabrics/i, 'the gate must not reveal underlying business page content');
  const csrf = readCsrf(html);

  const gateScript = await fetch(`${baseUrl}/_preview/gate.js`, { redirect: 'manual' });
  assert.equal(gateScript.status, 200);
  assert.match(gateScript.headers.get('content-type') || '', /javascript/);

  const badLogin = await fetch(`${baseUrl}/_preview/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: csrf, password: 'wrong-password', returnTo: '/suiting' })
  });
  assert.equal(badLogin.status, 401);
  assert.match(await badLogin.text(), /password was not accepted/i);
  cookie = sessionCookie(badLogin, cookie);

  const refreshedGate = await fetch(`${baseUrl}/_preview?returnTo=%2Fsuiting`, {
    redirect: 'manual', headers: { cookie }
  });
  assert.equal(refreshedGate.status, 200);
  cookie = sessionCookie(refreshedGate, cookie);
  html = await refreshedGate.text();

  const goodLogin = await fetch(`${baseUrl}/_preview/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: readCsrf(html), password: TEST_PASSWORD, returnTo: '/suiting' })
  });
  assert.equal(goodLogin.status, 303);
  assert.equal(goodLogin.headers.get('location'), '/suiting');
  cookie = sessionCookie(goodLogin, cookie);
  assert.ok(cookie, 'successful login should issue a session cookie');

  const suiting = await fetch(`${baseUrl}/suiting`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(suiting.status, 200);
  assert.match(await suiting.text(), /Suiting/i);
  const css = await fetch(`${baseUrl}/css/site.css`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('cache-control') || '', /no-store/);
  const upload = await fetch(`${baseUrl}/uploads/private-sentinel.txt`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(upload.status, 200);
  assert.equal(await upload.text(), 'protected-upload-sentinel');

  const admin = await fetch(`${baseUrl}/admin/dashboard`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(admin.status, 302, 'preview password must not grant admin access');
  assert.equal(admin.headers.get('location'), '/admin/login');

  const rootPage = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(rootPage.status, 200);
  const rootHtml = await rootPage.text();
  assert.match(rootHtml, /End Preview Session/);
  const logoutCsrf = readCsrf(rootHtml);
  const logout = await fetch(`${baseUrl}/_preview/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: logoutCsrf })
  });
  assert.equal(logout.status, 303);
  const afterLogout = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(afterLogout.status, 302, 'logout should require a new preview authentication');
});
