// End-to-end local HTTP/SMTP check. Uses a disposable account and local Mailpit only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.env.SMOKE_URL ?? 'http://localhost:3001';
const inbox = process.env.MAILPIT_URL ?? 'http://localhost:8025';
for (const value of [base, inbox]) {
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:', 'Smoke test is restricted to local development');
}
const products = JSON.parse(await readFile(new URL('../data/products.json', import.meta.url), 'utf8'));
const expected = JSON.parse(await readFile(new URL('../data/expected.json', import.meta.url), 'utf8'));
function client() {
  let cookie = ''; let csrf = '';
  return {
    async call(path, method = 'GET', body) {
      const response = await fetch(base + path, { method, headers: { Cookie: cookie, Origin: new URL(base).origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const setCookie = response.headers.getSetCookie()[0];
      if (setCookie) cookie = setCookie.split(';')[0];
      const result = response.status === 204 ? null : await response.json();
      if (result?.csrfToken) csrf = result.csrfToken;
      return { status: response.status, body: result };
    },
  };
}
async function emailToken(email, purpose) {
  const messages = await (await fetch(inbox + '/api/v1/messages')).json();
  const message = messages.messages.find(item => item.To.some(to => to.Address === email) && (purpose === 'verify' ? item.Subject.includes('Подтвердите') : item.Subject.includes('Восстановление')));
  assert.ok(message, 'Expected SMTP message in Mailpit');
  const detail = await (await fetch(inbox + '/api/v1/message/' + message.ID)).json();
  const token = new RegExp(`#${purpose}=([a-f0-9]{64})`).exec(detail.Text)?.[1];
  assert.ok(token, 'Expected single-use link');
  assert.ok(detail.Text.includes(base + '/#'), 'Email links point to the configured public origin');
  return token;
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* restarting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Application did not become ready');
}

await ready();
const page = await fetch(base);
assert.equal(page.status, 200);
const html = await page.text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
assert.equal(assets.length, 2);
for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200);
console.log('PASS HTML, JS/CSS, readiness');

const email = `smoke-${randomBytes(8).toString('hex')}@example.test`;
const password = randomBytes(18).toString('hex');
const newPassword = randomBytes(18).toString('hex');
const agent = client();
let loggedIn = false;
let activePassword = password;
try {
  assert.equal((await agent.call('/api/auth/session')).status, 200);
  assert.equal((await agent.call('/api/auth/register', 'POST', { email, password, name: 'Smoke Test' })).status, 202);
  const verify = await emailToken(email, 'verify');
  assert.equal((await agent.call('/api/auth/verify', 'POST', { token: verify })).status, 200);
  assert.equal((await agent.call('/api/auth/login', 'POST', { email, password })).status, 200);
  loggedIn = true;
  console.log('PASS registration, actual SMTP delivery, verification, login');
  assert.equal((await agent.call('/api/products', 'PUT', { products, version: 0 })).status, 200);
  assert.deepEqual((await agent.call('/reprice', 'POST', products)).body, expected);
  if (process.argv.includes('--restart')) {
    execFileSync('docker', ['compose', 'restart', 'app'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: 'pipe' });
    await ready();
  }
  assert.deepEqual((await agent.call('/api/products')).body.products, products);
  console.log('PASS saved catalog, pricing, session persistence');
  const guest = client(); await guest.call('/api/auth/session');
  assert.equal((await guest.call('/api/auth/request-reset', 'POST', { email })).status, 200);
  const reset = await emailToken(email, 'reset');
  assert.equal((await guest.call('/api/auth/reset', 'POST', { token: reset, password: newPassword })).status, 200);
  activePassword = newPassword;
  assert.equal((await agent.call('/api/products')).status, 401);
  await agent.call('/api/auth/session');
  assert.equal((await agent.call('/api/auth/login', 'POST', { email, password: newPassword })).status, 200);
  console.log('PASS actual reset email, new password, revoked old session');
} finally {
  if (loggedIn) {
    await agent.call('/api/auth/session');
    await agent.call('/api/auth/login', 'POST', { email, password: activePassword });
    assert.equal((await agent.call('/api/account', 'DELETE', { password: activePassword })).status, 204);
    console.log('PASS disposable account deleted');
  }
}
