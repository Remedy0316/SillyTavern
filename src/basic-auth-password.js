import crypto from 'node:crypto';

export const MAX_PASSWORD_BYTES = 1024;
const MAX_CONCURRENT_CHECKS = 2;
let activeChecks = 0;

export class PasswordCheckBusyError extends Error {
    constructor() {
        super('Password verification is busy.');
    }
}

/** Validate the encoded hash and bound its resource cost before calling native code. */
export function validatePasswordHash(value) {
    const match = typeof value === 'string' && value.length <= 256
        && /^\$argon2id\$v=19\$m=([1-9]\d{0,5}),t=([1-9]),p=([1-9])\$([A-Za-z0-9+/]{22,86})\$([A-Za-z0-9+/]{43,86})$/.exec(value);
    if (!match || match[0] !== value || Number(match[1]) < 19456 || Number(match[1]) > 65536
        || Number(match[2]) < 2 || Number(match[2]) > 6 || Number(match[3]) > 4
        || [match[4], match[5]].some(part => Buffer.from(part, 'base64').toString('base64').replace(/=+$/, '') !== part)) {
        throw new Error('Set basicAuthUser.passwordHash to a valid Argon2id hash generated with npm run hash-password.');
    }
}

export function validPasswordInput(password) {
    return typeof password === 'string' && password.length > 0
        && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}

/** Both shared-credential authentication paths use this process-wide concurrency limit. */
export async function verifyPasswordHash(passwordHash, password) {
    validatePasswordHash(passwordHash);
    if (!validPasswordInput(password)) return false;
    if (activeChecks >= MAX_CONCURRENT_CHECKS) throw new PasswordCheckBusyError();
    activeChecks++;
    try {
        const { verify } = await import('@node-rs/argon2');
        return await verify(passwordHash, password);
    } finally {
        activeChecks--;
    }
}

/** Generate a PHC string containing the random salt, parameters, and password hash. */
export async function generatePasswordHash(password) {
    if (!validPasswordInput(password)) {
        throw new Error(`Use a nonempty password of at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
    }
    const { hash, Algorithm, Version } = await import('@node-rs/argon2');
    return hash(password, {
        algorithm: Algorithm.Argon2id,
        version: Version.V0x13,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
        outputLen: 32,
        salt: crypto.randomBytes(16),
    });
}
