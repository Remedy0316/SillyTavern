import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

const LOGIN_PATH = '/basic-auth/login';
const PUBLIC_ASSETS = new Map([
    ['/basic-auth/assets/login.css', 'css/basic-auth-login.css'],
    ['/basic-auth/assets/login.js', 'scripts/basic-auth-login.js'],
    ['/basic-auth/assets/logo.png', 'img/logo.png'],
    ['/basic-auth/assets/icons.woff2', 'webfonts/fa-solid-900.woff2'],
    ['/manifest.json', 'manifest.json'],
    ['/img/apple-icon-57x57.png', 'img/apple-icon-57x57.png'],
    ['/img/apple-icon-72x72.png', 'img/apple-icon-72x72.png'],
    ['/img/apple-icon-114x114.png', 'img/apple-icon-114x114.png'],
    ['/img/apple-icon-144x144.png', 'img/apple-icon-144x144.png'],
    ['/img/apple-icon-192x192.png', 'img/apple-icon-192x192.png'],
    ['/img/apple-icon-512x512.png', 'img/apple-icon-512x512.png'],
]);

function digest(value) {
    return crypto.createHash('sha256').update(value).digest();
}

function equal(left, right) {
    return typeof left === 'string' && typeof right === 'string'
        && crypto.timingSafeEqual(digest(left), digest(right));
}

function safeDestination(value) {
    return typeof value === 'string' && /^\/(?!\/)/.test(value)
        && !/[\\\x00-\x20]/.test(value) && !value.startsWith('/basic-auth') ? value : '/';
}

/**
 * Creates an independent, shared-credential gate. Sessions are intentionally process-local.
 * @param {object} options Configuration
 * @param {() => { username: string, password: string }} options.getCredentials Credential reader
 * @param {string} options.publicRoot Bundled public directory
 * @param {boolean} [options.secureCookie] Require HTTPS cookies
 * @param {number} [options.sessionHours] Absolute session lifetime
 * @param {number} [options.maxAttempts] Failed attempts per minute per socket IP
 * @returns {import('express').Router} Authentication gate
 */
export function createBasicAuthLogin({ getCredentials, publicRoot, secureCookie = true, sessionHours = 168, maxAttempts = 5 }) {
    if (!Number.isFinite(sessionHours) || sessionHours <= 0 || sessionHours > 720) {
        throw new Error('basicAuthLoginSessionHours must be between 0 (exclusive) and 720.');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
        throw new Error('Form login requires rateLimiting.basicAuthMaxAttempts to be a positive integer.');
    }

    const router = express.Router({ caseSensitive: true, strict: true });
    const secret = crypto.randomBytes(32);
    const sessions = new Map();
    const lifetime = sessionHours * 60 * 60 * 1000;
    const sessionName = secureCookie ? '__Host-st-gate' : 'st-gate-local';
    const csrfName = secureCookie ? '__Host-st-gate-csrf' : 'st-gate-csrf-local';
    const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: /** @type {const} */ ('lax'), path: '/' };
    const limiter = new RateLimiterMemory({ points: maxAttempts, duration: 60 });
    const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');

    router.use(cookieParser());
    router.use(async (request, response, next) => {
        try {
            const credentials = getCredentials();
            if (typeof credentials.username !== 'string' || !credentials.username
                || typeof credentials.password !== 'string' || !credentials.password) {
                throw new Error('Form login requires nonempty Basic Auth credentials.');
            }
            const version = sign(JSON.stringify([credentials.username, credentials.password]));
            const sessionId = request.cookies[sessionName];
            const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
            const authenticated = !!session && session.expires > Date.now() && equal(session.version, version);
            if (session && !authenticated) {
                sessions.delete(sessionId);
            }

            const authRoute = request.path.startsWith('/basic-auth/');
            if (authRoute || PUBLIC_ASSETS.has(request.path)) {
                response.set({
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy': 'default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\'; font-src \'self\'; manifest-src \'self\'; connect-src \'self\'; base-uri \'none\'; form-action \'self\'; frame-ancestors \'none\'',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Frame-Options': 'DENY',
                    'Referrer-Policy': 'no-referrer',
                });
            }

            if (request.method === 'GET' && request.path === LOGIN_PATH) {
                return response.sendFile('basic-auth-login.html', { root: publicRoot });
            }
            if (['GET', 'HEAD'].includes(request.method) && PUBLIC_ASSETS.has(request.path)) {
                return response.sendFile(path.resolve(publicRoot, PUBLIC_ASSETS.get(request.path)));
            }
            if (request.method === 'GET' && request.path === '/basic-auth/session') {
                const nonce = crypto.randomBytes(32).toString('hex');
                const expires = Date.now() + 10 * 60 * 1000;
                const payload = `${nonce}.${expires}`;
                const token = `${payload}.${sign(payload)}`;
                response.cookie(csrfName, token, { ...cookieOptions, sameSite: 'strict', maxAge: 10 * 60 * 1000 });
                return response.json({ token, authenticated });
            }

            const checkCredentials = async (username, password) => {
                const key = request.socket.remoteAddress || 'unknown';
                await limiter.consume(key);
                const usernameMatches = equal(username, credentials.username);
                const passwordMatches = equal(password, credentials.password);
                if (usernameMatches && passwordMatches) {
                    await limiter.delete(key);
                    return true;
                }
                return false;
            };

            if (request.method === 'POST' && [LOGIN_PATH, '/basic-auth/logout'].includes(request.path)) {
                const token = request.get('x-csrf-token');
                const cookie = request.cookies[csrfName];
                const parts = typeof token === 'string' ? token.split('.') : [];
                if (request.get('sec-fetch-site') === 'cross-site' || !equal(token, cookie)
                    || parts.length !== 3 || Number(parts[1]) <= Date.now() || !Number.isFinite(Number(parts[1]))
                    || !equal(parts[2], sign(`${parts[0]}.${parts[1]}`))) {
                    return response.status(403).json({ error: 'Your sign-in page expired. Refresh and try again.' });
                }
                if (request.path === '/basic-auth/logout') {
                    sessions.delete(sessionId);
                    response.clearCookie(sessionName, cookieOptions);
                    response.clearCookie(csrfName, cookieOptions);
                    return response.sendStatus(204);
                }
                return express.json({ limit: '4kb' })(request, response, async (error) => {
                    if (error) {
                        return response.status(400).json({ error: 'Invalid sign-in request.' });
                    }
                    try {
                        if (!await checkCredentials(request.body?.username, request.body?.password)) {
                            return response.status(401).json({ error: 'Incorrect username or password.' });
                        }
                        for (const [key, value] of sessions) {
                            if (value.expires <= Date.now() || !equal(value.version, version)) sessions.delete(key);
                        }
                        if (sessions.size >= 1000) {
                            sessions.delete(sessions.keys().next().value);
                        }
                        sessions.delete(sessionId);
                        const newId = crypto.randomBytes(32).toString('hex');
                        sessions.set(newId, { expires: Date.now() + lifetime, version });
                        response.cookie(sessionName, newId, { ...cookieOptions, maxAge: lifetime });
                        return response.json({ redirect: safeDestination(request.body?.returnTo) });
                    } catch (error) {
                        return handleError(error, response);
                    }
                });
            }

            if (authenticated) return next();
            const authorization = request.get('authorization');
            if (authorization) {
                const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(authorization);
                if (match) {
                    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
                    const separator = decoded.indexOf(':');
                    if (separator >= 0 && await checkCredentials(decoded.slice(0, separator), decoded.slice(separator + 1))) {
                        return next();
                    }
                }
                response.set('WWW-Authenticate', 'Basic realm="SillyTavern", charset="UTF-8"');
            }
            response.set('Cache-Control', 'no-store');
            if (!authorization && request.method === 'GET' && !request.path.startsWith('/api/')
                && (request.get('sec-fetch-mode') === 'navigate' || (request.path === '/' && request.accepts('html')))) {
                return response.redirect(`${LOGIN_PATH}?returnTo=${encodeURIComponent(safeDestination(request.originalUrl))}`);
            }
            return response.status(401).json({ error: 'Authentication required.' });
        } catch (error) {
            return handleError(error, response);
        }
    });

    function handleError(error, response) {
        if (error instanceof RateLimiterRes) {
            response.set('Retry-After', String(Math.max(1, Math.ceil(error.msBeforeNext / 1000))));
            return response.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
        }
        return response.status(500).json({ error: 'Authentication unavailable.' });
    }

    return router;
}
