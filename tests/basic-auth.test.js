import { afterEach, beforeAll, beforeEach, describe, expect, test, jest } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { createBasicAuthLogin } from '../src/middleware/basicAuthLogin.js';
import { generatePasswordHash } from '../src/basic-auth-password.js';

let server;
let origin;
let credentials;
let passwordHash;
let replacementHash;
const password = 'test:password';

jest.setTimeout(15000);
beforeAll(async () => {
    passwordHash = await generatePasswordHash(password);
    replacementHash = await generatePasswordHash('changed-password');
});

async function start(options = {}) {
    credentials = { username: 'test-user', passwordHash };
    const app = express();
    app.use(createBasicAuthLogin({
        getCredentials: () => credentials,
        publicRoot: fileURLToPath(new URL('../public/', import.meta.url)),
        secureCookie: false,
        ...options,
    }));
    app.post('/api/upload', express.raw({ type: '*/*' }), (request, response) => response.send(request.body));
    app.get('/api/stream', (request, response) => {
        response.type('text/event-stream');
        response.write('data: first\n\n');
        response.end('data: [DONE]\n\n');
    });
    app.use((request, response) => response.json({ protected: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
}

async function csrf() {
    const response = await fetch(`${origin}/basic-auth/session`);
    return { token: (await response.json()).token, cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function login(body = { username: credentials.username, password }, challenge) {
    challenge ??= await csrf();
    return fetch(`${origin}/basic-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: challenge.cookie, 'x-csrf-token': challenge.token },
        body: JSON.stringify(body),
    });
}

beforeEach(async () => start());
afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
});

describe('shared Basic Auth form gate', () => {
    test('blocks unauthenticated pages, APIs, extension files, and asset traversal', async () => {
        for (const resource of ['/', '/api/secrets/read', '/api/backends/chat-completions/generate', '/characters/private.png', '/scripts/extensions/test.js', '/style.css', '/csrf-token', '/basic-auth/assets/../style.css', '/basic-auth/assets/%2e%2e%2fstyle.css', '/BASIC-AUTH/session', '/basic-auth/session/']) {
            const response = await fetch(`${origin}${resource}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
            expect(response.status).toBe(401);
            expect(response.headers.has('www-authenticate')).toBe(false);
        }
    });

    test('redirects navigation but never API calls', async () => {
        const navigation = await fetch(`${origin}/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
        expect(navigation.status).toBe(302);
        expect(navigation.headers.get('location')).toContain('/basic-auth/login');
        const api = await fetch(`${origin}/api/test`, { redirect: 'manual', headers: { Accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
        expect(api.status).toBe(401);
    });

    test('authenticates existing credentials and revokes logout cookies server-side', async () => {
        const challenge = await csrf();
        const response = await login({ username: credentials.username, password }, challenge);
        expect(response.status).toBe(200);
        const cookie = response.headers.get('set-cookie').split(';')[0];
        expect(cookie).not.toContain(password);
        expect(cookie).not.toContain(credentials.passwordHash);
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: cookie } })).status).toBe(200);
        const logout = await fetch(`${origin}/basic-auth/logout`, {
            method: 'POST', headers: { Cookie: `${cookie}; ${challenge.cookie}`, 'x-csrf-token': challenge.token },
        });
        expect(logout.status).toBe(204);
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: cookie } })).status).toBe(401);
    });

    test('rejects forged cookies and invalidates sessions when credentials change', async () => {
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: 'st-gate-local=forged' } })).status).toBe(401);
        const response = await login();
        const cookie = response.headers.get('set-cookie').split(';')[0];
        credentials.passwordHash = replacementHash;
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: cookie } })).status).toBe(401);
    });

    test('expires sessions server-side', async () => {
        const response = await login();
        const cookie = response.headers.get('set-cookie').split(';')[0];
        const future = Date.now() + 169 * 60 * 60 * 1000;
        jest.spyOn(Date, 'now').mockReturnValue(future);
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: cookie } })).status).toBe(401);
    });

    test('rejects login and logout without CSRF proof', async () => {
        for (const action of ['login', 'logout']) {
            const response = await fetch(`${origin}/basic-auth/${action}`, { method: 'POST' });
            expect(response.status).toBe(403);
        }
        const response = await login(credentials, { token: 'forged', cookie: 'st-gate-csrf-local=forged' });
        expect(response.status).toBe(403);
    });

    test('rate limits both form and Basic-header failures without trusting forwarded IPs', async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            expect((await login({ username: 'wrong', password: 'wrong' })).status).toBe(401);
        }
        const response = await fetch(`${origin}/api/test`, {
            headers: { Authorization: `Basic ${Buffer.from('test-user:test:password').toString('base64')}`, 'x-forwarded-for': '1.2.3.4' },
        });
        expect(response.status).toBe(429);
        expect(response.headers.has('retry-after')).toBe(true);
    });

    test('keys the rate limiter by forwarded IP when preferRealIpHeader is enabled', async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        // Tests have no config.yaml; supply the forwarded-header settings via env overrides.
        const env = {
            SILLYTAVERN_FORWARDEDHEADERS_XREALIP: 'true',
            SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP: 'false',
            SILLYTAVERN_FORWARDEDHEADERS_XFORWARDEDFOR: 'true',
        };
        Object.assign(process.env, env);
        try {
            await start({ preferRealIpHeader: true });
            const attempt = ip => fetch(`${origin}/api/test`, {
                headers: { Authorization: `Basic ${Buffer.from('wrong:wrong').toString('base64')}`, 'x-forwarded-for': ip },
            });
            for (let i = 0; i < 5; i++) {
                expect((await attempt('1.2.3.4')).status).toBe(401);
            }
            expect((await attempt('1.2.3.4')).status).toBe(429);
            expect((await attempt('5.6.7.8')).status).toBe(401);
        } finally {
            for (const key of Object.keys(env)) delete process.env[key];
        }
    });

    test('preserves Basic headers, including colon-containing passwords', async () => {
        const response = await fetch(`${origin}/api/test`, {
            headers: { Authorization: `Basic ${Buffer.from('test-user:test:password').toString('base64')}` },
        });
        expect(response.status).toBe(200);
    });

    test('rejects unsafe return URLs', async () => {
        for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example', '/basic-auth/login']) {
            const response = await login({ username: credentials.username, password, returnTo });
            expect((await response.json()).redirect).toBe('/');
        }
    });

    test('only serves explicitly listed login assets and applies security headers', async () => {
        for (const resource of ['/basic-auth/login', '/basic-auth/assets/login.css', '/basic-auth/assets/login.js', '/basic-auth/assets/logo.png', '/basic-auth/assets/icons.woff2']) {
            const response = await fetch(`${origin}${resource}`);
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'');
        }
    });

    test('serves the shared manifest and its exact icons before login', async () => {
        const page = await fetch(`${origin}/basic-auth/login`);
        const html = await page.text();
        expect(html).toContain('rel="manifest" href="/manifest.json"');
        expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
        expect(html).toContain('rel="apple-touch-icon" sizes="192x192" href="/img/apple-icon-192x192.png"');
        expect(page.headers.get('content-security-policy')).toContain('manifest-src \'self\'');
        const response = await fetch(`${origin}/manifest.json`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const manifest = await response.json();
        expect(manifest.start_url).toBe('/');
        expect(manifest.scope).toBe('/');
        expect(manifest.display).toBe('standalone');
        for (const icon of manifest.icons) {
            const url = new URL(icon.src, `${origin}/manifest.json`);
            expect(url.origin).toBe(origin);
            const image = await fetch(url);
            expect(image.status).toBe(200);
            expect(image.headers.get('content-type')).toContain('image/png');
        }
        const head = await fetch(`${origin}/manifest.json`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        const start = await fetch(new URL(manifest.start_url, origin), { redirect: 'manual', headers: { Accept: 'text/html' } });
        expect(start.status).toBe(302);
        expect(start.headers.get('location')).toContain('/basic-auth/login');
    });

    test('keeps neighboring files and non-read metadata requests protected', async () => {
        for (const resource of ['/img/logo.png', '/img/user-default.png', '/img/apple-icon-192x192.png/extra', '/manifest.json/extra', '/img/%2e%2e%2fscript.js', '/script.js', '/api/users/me']) {
            const response = await fetch(`${origin}${resource}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
            expect(response.status).toBe(401);
        }
        for (const resource of ['/manifest.json', '/img/apple-icon-192x192.png']) {
            const response = await fetch(`${origin}${resource}`, { method: 'POST' });
            expect(response.status).toBe(401);
        }
    });

    test('rejects cross-site or expired CSRF proof and oversized payloads', async () => {
        const challenge = await csrf();
        const crossSite = await fetch(`${origin}/basic-auth/login`, {
            method: 'POST', headers: { Cookie: challenge.cookie, 'x-csrf-token': challenge.token, 'sec-fetch-site': 'cross-site' },
        });
        expect(crossSite.status).toBe(403);
        expect((await login({ ...credentials, extra: 'a'.repeat(5000) }, challenge)).status).toBe(400);
        const future = Date.now() + 11 * 60 * 1000;
        jest.spyOn(Date, 'now').mockReturnValue(future);
        expect((await login(credentials, challenge)).status).toBe(403);
    });

    test('uses secure host-only cookies by default, even behind TLS termination', async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await start({ secureCookie: true });
        const response = await login();
        const cookie = response.headers.get('set-cookie');
        expect(cookie).toContain('__Host-st-gate=');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
        expect(cookie).not.toContain('Domain=');
    });

    test('passes authenticated binary uploads and streaming responses through untouched', async () => {
        const response = await login();
        const cookie = response.headers.get('set-cookie').split(';')[0];
        const data = Buffer.from([0, 255, 13, 10, 128]);
        const upload = await fetch(`${origin}/api/upload`, {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: data,
        });
        expect(Buffer.from(await upload.arrayBuffer())).toEqual(data);
        const stream = await fetch(`${origin}/api/stream`, { headers: { Cookie: cookie } });
        expect(await stream.text()).toBe('data: first\n\ndata: [DONE]\n\n');
    });

    test('counts simultaneous password guesses atomically', async () => {
        const challenge = await csrf();
        const responses = await Promise.all(Array.from({ length: 12 }, () => login({ username: 'wrong', password: 'wrong' }, challenge)));
        expect(responses.every(response => [401, 429].includes(response.status))).toBe(true);
        expect(responses.filter(response => response.status === 401).length).toBeGreaterThan(0);
        expect(responses.filter(response => response.status === 401).length).toBeLessThanOrEqual(5);
        expect(responses.filter(response => response.status === 429).length).toBeGreaterThanOrEqual(7);
        expect((await login()).status).toBe(429);
    });

    test('fails closed with missing credentials', async () => {
        credentials.passwordHash = '';
        expect((await fetch(`${origin}/api/test`)).status).toBe(500);
    });

    test('requires a valid hash at startup, even when a plaintext password is supplied', () => {
        for (const value of [undefined, '', 'invalid', passwordHash.replace('argon2id', 'argon2i')]) {
            expect(() => createBasicAuthLogin({
                getCredentials: () => ({ username: 'test-user', password, passwordHash: value }),
                publicRoot: '.',
            })).toThrow('passwordHash');
        }
    });

    test('never accepts the encoded hash or a leftover plaintext credential as the password', async () => {
        credentials.password = 'old-plaintext';
        expect((await login({ username: credentials.username, password: credentials.passwordHash })).status).toBe(401);
        expect((await login({ username: credentials.username, password: 'old-plaintext' })).status).toBe(401);
        expect((await login()).status).toBe(200);
    });

    test('rejects malformed password inputs and wrong usernames', async () => {
        for (const candidate of [null, {}, '', 'a'.repeat(1025)]) {
            expect((await login({ username: credentials.username, password: candidate })).status).toBe(401);
        }
        expect((await login({ username: 'wrong', password })).status).toBe(401);
    });

    test('invalid hash changes revoke existing sessions and never use plaintext fallback', async () => {
        const response = await login();
        const challenge = await csrf();
        const cookie = response.headers.get('set-cookie').split(';')[0];
        credentials.passwordHash = 'malformed';
        credentials.password = password;
        expect((await fetch(`${origin}/api/test`, { headers: { Cookie: cookie } })).status).toBe(500);
        expect((await login({ username: credentials.username, password }, challenge)).status).toBe(500);
    });

    test('password rotation accepts only the new password', async () => {
        credentials.passwordHash = replacementHash;
        expect((await login()).status).toBe(401);
        expect((await login({ username: credentials.username, password: 'changed-password' })).status).toBe(200);
    });

    test('installs the opt-in gate before application parsers and routes, preserving legacy auth', () => {
        const source = fs.readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
        const position = source.indexOf('app.use(createBasicAuthLogin(');
        expect(position).toBeGreaterThan(-1);
        for (const marker of ['app.use(bodyParser.json', 'app.use(express.static', 'app.use(webpackMiddleware)', 'setupPrivateEndpoints(app)', 'await loadPlugins(app']) {
            expect(position).toBeLessThan(source.indexOf(marker));
        }
        expect(source).toContain('getConfigValue(\'basicAuthLoginPage\', false, \'boolean\')');
        expect(source).toContain('cliArgs.listen && cliArgs.basicAuthMode && !basicAuthLoginPage');
        expect(source).toContain('getConfigValue(\'enableUserAccounts\', false, \'boolean\')');
        expect(source).toContain('getConfigValue(\'perUserBasicAuth\', false, \'boolean\')');
    });
});

describe('password-manager-friendly login submission', () => {
    async function createForm({ validCredentials = true, retainedCookie = true } = {}) {
        const elements = new Map();
        for (const id of ['login-form', 'status', 'submit', 'submit-label', 'username', 'password', 'toggle-password', 'signed-in', 'logout', 'continue']) {
            elements.set(`#${id}`, { value: '', hidden: false, disabled: true, addEventListener: jest.fn() });
        }
        elements.get('#username').value = 'test-user';
        elements.get('#password').value = 'test:password';
        let submitted = false;
        const navigate = jest.fn(() => ({
            password: elements.get('#password').value,
            formHidden: elements.get('#login-form').hidden,
        }));
        const fetchMock = jest.fn(async resource => {
            if (resource === '/basic-auth/login') {
                submitted = true;
                return { ok: validCredentials, json: async () => validCredentials ? { redirect: '/' } : { error: 'Incorrect username or password.' } };
            }
            return { ok: true, json: async () => ({ token: 'test-csrf', authenticated: submitted && validCredentials && retainedCookie }) };
        });
        const source = fs.readFileSync(new URL('../public/scripts/basic-auth-login.js', import.meta.url), 'utf8');
        await vm.runInNewContext(source, {
            document: { querySelector: selector => elements.get(selector) },
            location: { search: '', assign: navigate },
            fetch: fetchMock,
            URLSearchParams,
        });
        const submitHandler = elements.get('#login-form').addEventListener.mock.calls.find(([event]) => event === 'submit')[1];
        return { elements, navigate, fetchMock, submit: () => submitHandler({ preventDefault() {} }) };
    }

    test('preserves filled fields and visible form through verified successful navigation', async () => {
        const { elements, navigate, fetchMock, submit } = await createForm();
        await submit();
        expect(navigate).toHaveBeenCalledWith('/');
        expect(navigate.mock.results[0].value).toEqual({ password: 'test:password', formHidden: false });
        expect(elements.get('#username').value).toBe('test-user');
        const request = fetchMock.mock.calls.find(([resource]) => resource === '/basic-auth/login')[1];
        expect(request.headers['x-csrf-token']).toBe('test-csrf');
        expect(JSON.parse(request.body)).toEqual({ username: 'test-user', password: 'test:password', returnTo: '/' });
    });

    test('keeps the form available and does not navigate on rejected credentials', async () => {
        const { elements, navigate, submit } = await createForm({ validCredentials: false });
        await submit();
        expect(navigate).not.toHaveBeenCalled();
        expect(elements.get('#status').textContent).toBe('Incorrect username or password.');
        expect(elements.get('#password').value).toBe('test:password');
        expect(elements.get('#login-form').hidden).toBe(false);
        expect(elements.get('#submit').disabled).toBe(false);
    });

    test('requires a retained session cookie before navigating', async () => {
        const { elements, navigate, submit } = await createForm({ retainedCookie: false });
        await submit();
        expect(navigate).not.toHaveBeenCalled();
        expect(elements.get('#status').textContent).toContain('did not retain the login cookie');
        expect(elements.get('#login-form').hidden).toBe(false);
        expect(elements.get('#password').value).toBe('test:password');
    });
});
