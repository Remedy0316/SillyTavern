import { beforeAll, describe, expect, test, jest } from '@jest/globals';
import { PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generatePasswordHash, validatePasswordHash, verifyPasswordHash, PasswordCheckBusyError } from '../src/basic-auth-password.js';
import { promptForPassword } from '../src/hash-password.js';

jest.setTimeout(15000);
const password = ' a long : password 🌸 密碼 ';
let passwordHash;
beforeAll(async () => { passwordHash = await generatePasswordHash(password); });

describe('Argon2id password storage', () => {
    test('generates salted hashes with the intended parameters and verifies Unicode passwords exactly', async () => {
        const another = await generatePasswordHash(password);
        expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
        expect(another).not.toBe(passwordHash);
        expect(() => validatePasswordHash(passwordHash)).not.toThrow();
        expect(await verifyPasswordHash(passwordHash, password)).toBe(true);
        expect(await verifyPasswordHash(passwordHash, password.trim())).toBe(false);
        expect(await verifyPasswordHash(passwordHash, password + ' ')).toBe(false);
        expect(await verifyPasswordHash(passwordHash, passwordHash)).toBe(false);
    });

    test('rejects malformed, weak, or excessive-cost hashes before verification', async () => {
        for (const candidate of [undefined, null, 123, '', 'plaintext',
            passwordHash.replace('argon2id', 'argon2i'), passwordHash.replace('v=19', 'v=16'),
            passwordHash.replace('m=65536', 'm=8'), passwordHash.replace('m=65536', 'm=999999'),
            passwordHash.replace('t=3', 't=1'), passwordHash.replace('t=3', 't=9'),
            passwordHash.replace('p=1', 'p=9'), passwordHash + '=', passwordHash + '\n']) {
            expect(() => validatePasswordHash(candidate)).toThrow('passwordHash');
            await expect(verifyPasswordHash(candidate, password)).rejects.toThrow('passwordHash');
        }
    });

    test('bounds concurrent native work and releases slots after unsuccessful checks', async () => {
        const pending = [verifyPasswordHash(passwordHash, 'wrong'), verifyPasswordHash(passwordHash, password)];
        try {
            await expect(verifyPasswordHash(passwordHash, password)).rejects.toBeInstanceOf(PasswordCheckBusyError);
            expect(await Promise.all(pending)).toEqual([false, true]);
        } finally {
            await Promise.allSettled(pending);
        }
        expect(await verifyPasswordHash(passwordHash, password)).toBe(true);
    });

    test('bounds input by UTF-8 bytes and rejects non-string passwords', async () => {
        for (const value of ['', null, {}, '🌸'.repeat(257)]) {
            expect(await verifyPasswordHash(passwordHash, value)).toBe(false);
            await expect(generatePasswordHash(value)).rejects.toThrow('1024');
        }
    });
});

describe('hidden local password prompt', () => {
    test('CLI refuses unsafe input sources without echoing credentials', async () => {
        for (const args of [[], ['do-not-echo-this-test-password']]) {
            const result = await promisify(execFile)(process.execPath,
                [fileURLToPath(new URL('../src/hash-password.js', import.meta.url)), ...args],
                { timeout: 5000, windowsHide: true }).catch(error => error);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).not.toContain('do-not-echo-this-test-password');
            expect(result.stderr).toMatch(/interactive terminal|Do not pass a password/);
        }
    });

    async function prompt(first, second) {
        const input = new PassThrough();
        input.isTTY = true;
        let visible = '';
        const output = new Writable({ write(chunk, encoding, callback) {
            visible += chunk.toString();
            if (chunk.toString().includes('New password')) setImmediate(() => input.write(first + '\r'));
            if (chunk.toString().includes('Confirm password')) setImmediate(() => input.write(second + '\r'));
            callback();
        } });
        try {
            return { password: await promptForPassword(input, output), visible };
        } finally {
            input.destroy();
            output.destroy();
        }
    }

    test('reads and confirms without echoing the secret', async () => {
        const result = await prompt(password, password);
        expect(result.password).toBe(password);
        expect(result.visible).not.toContain(password);
        expect(result.visible).toContain('Confirm password');
    });

    test('rejects mismatches and empty passwords', async () => {
        await expect(prompt('first', 'second')).rejects.toThrow('did not match');
        await expect(prompt('', '')).rejects.toThrow('nonempty');
    });

    test('rejects non-interactive input', async () => {
        const input = new PassThrough();
        try {
            await expect(promptForPassword(input)).rejects.toThrow('interactive terminal');
        } finally {
            input.destroy();
        }
    });

    test('cancels on Ctrl+C and restores terminal input mode', async () => {
        const input = new PassThrough();
        input.isTTY = true;
        input.setRawMode = jest.fn();
        const output = new Writable({ write(chunk, encoding, callback) {
            setImmediate(() => input.write('\x03'));
            callback();
        } });
        try {
            await expect(promptForPassword(input, output)).rejects.toMatchObject({ name: 'AbortError' });
            expect(input.setRawMode).toHaveBeenLastCalledWith(false);
            expect(input.isPaused()).toBe(true);
        } finally {
            input.destroy();
            output.destroy();
        }
    });
});
