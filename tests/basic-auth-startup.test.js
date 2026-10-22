import { afterAll, beforeAll, expect, test, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generatePasswordHash } from '../src/basic-auth-password.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
let fixture;
let passwordHash;
jest.setTimeout(20000);
beforeAll(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'st-argon2-startup-'));
    await fs.copyFile(path.join(root, 'default/config.yaml'), path.join(fixture, 'config.yaml'));
    passwordHash = await generatePasswordHash('startup-test-password');
});
afterAll(async () => {
    // Only remove the exact test-owned directory, never the repository's data directory.
    if (fixture && path.dirname(fixture) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('st-argon2-startup-')) {
        await fs.rm(fixture, { recursive: true, force: true });
    }
});

test.each([
    ['missing hash', {}, 'Set basicAuthUser.passwordHash'],
    ['malformed hash', { SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH: 'invalid' }, 'Set basicAuthUser.passwordHash'],
    ['leftover plaintext variable', { SILLYTAVERN_BASICAUTHUSER_PASSWORD: 'old-test-password' }, 'Remove SILLYTAVERN_BASICAUTHUSER_PASSWORD'],
    ['empty plaintext variable', { SILLYTAVERN_BASICAUTHUSER_PASSWORD: '' }, 'Remove SILLYTAVERN_BASICAUTHUSER_PASSWORD'],
])('refuses actual server startup with %s', async (label, overrides, expected) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SILLYTAVERN_')));
    Object.assign(env, {
        SILLYTAVERN_BASICAUTHLOGINPAGE: 'true',
        SILLYTAVERN_BASICAUTHUSER_USERNAME: 'startup-test-user',
        SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH: label.includes('plaintext') ? passwordHash : '',
        ...overrides,
    });
    // execFile's timeout kills and waits for this exact child if startup unexpectedly hangs.
    const result = await run(process.execPath, ['server.js', '--configPath', path.join(fixture, 'config.yaml'),
        '--dataRoot', path.join(fixture, 'data'), '--listen', 'true', '--basicAuthMode', 'true',
        '--browserLaunchEnabled', 'false', '--port', '0'], { cwd: root, env, timeout: 15000, windowsHide: true });
    expect(result.stderr).toContain(expected);
    expect(result.stdout).not.toContain('SillyTavern is listening');
    expect(result.stderr).not.toContain('old-test-password');
    expect(result.stderr).not.toContain(passwordHash);
});
