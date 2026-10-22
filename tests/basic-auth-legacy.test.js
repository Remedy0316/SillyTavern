import { afterEach, beforeAll, beforeEach, expect, test, jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';
import { generatePasswordHash } from '../src/basic-auth-password.js';

// Exercise the original middleware against public defaults, without loading user data.
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
global.DATA_ROOT = fileURLToPath(new URL('../default/', import.meta.url));
jest.unstable_mockModule('../src/users.js', () => ({
    getAllUserHandles: jest.fn(), toKey: jest.fn(), getPasswordHash: jest.fn(),
}));
const { default: basicAuthMiddleware } = await import('../src/middleware/basicAuth.js');
let server;
let origin;
let passwordHash;
let originalEnv;
const password = 'legacy:hash-password';
const keys = ['SILLYTAVERN_BASICAUTHUSER_USERNAME', 'SILLYTAVERN_BASICAUTHUSER_PASSWORD', 'SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH'];
jest.setTimeout(15000);

beforeAll(async () => { passwordHash = await generatePasswordHash(password); });
beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.SILLYTAVERN_BASICAUTHUSER_USERNAME = 'test-user';
    process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORD = 'old-plaintext';
    process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH = passwordHash;
    const app = express();
    app.use(basicAuthMiddleware);
    app.use((request, response) => response.json({ protected: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    try {
        server?.closeAllConnections();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
    } finally {
        for (const key of keys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        jest.restoreAllMocks();
    }
});

const request = (candidate, username = 'test-user') => fetch(origin, {
    headers: candidate === undefined ? {} : { Authorization: `Basic ${Buffer.from(`${username}:${candidate}`).toString('base64')}` },
    signal: AbortSignal.timeout(5000),
});

test('hash-only Basic Auth works without a plaintext environment variable', async () => {
    delete process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORD;
    expect((await request(password)).status).toBe(200);
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
});

test('the hash overrides plaintext, including the bundled default password', async () => {
    expect((await request('old-plaintext')).status).toBe(401);
    expect((await request(passwordHash)).status).toBe(401);
    delete process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORD;
    expect((await request('password')).status).toBe(401);
    expect((await request(password)).status).toBe(200);
});

test('invalid hash configuration cannot fall back to plaintext', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH = 'invalid';
    expect((await request('old-plaintext')).status).toBe(500);
    process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH = passwordHash;
    expect((await request(password)).status).toBe(200);
});

test('preserves upstream plaintext Basic Auth when the login page and hash option are not used', async () => {
    delete process.env.SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH;
    expect((await request('old-plaintext')).status).toBe(200);
    expect((await request('wrong')).status).toBe(401);
    expect((await request('old-plaintext')).status).toBe(200);
});

test('limits simultaneous guesses before expensive hash work', async () => {
    expect((await request(password)).status).toBe(200);
    const responses = await Promise.all(Array.from({ length: 12 }, () => request('wrong')));
    expect(responses.every(response => [401, 429].includes(response.status))).toBe(true);
    expect(responses.filter(response => response.status === 429).length).toBeGreaterThanOrEqual(7);
    expect((await request(password)).status).toBe(429);
});
