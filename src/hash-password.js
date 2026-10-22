import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { generatePasswordHash, validPasswordInput, MAX_PASSWORD_BYTES } from './basic-auth-password.js';

/** Read twice without echoing input or accepting passwords in arguments or environment variables. */
export async function promptForPassword(input = process.stdin, output = process.stderr) {
    if (!input.isTTY) throw new Error('Run npm run hash-password in an interactive terminal.');
    const silentOutput = new Writable({ write(chunk, encoding, callback) { callback(); } });
    const reader = createInterface({ input, output: silentOutput, terminal: true, historySize: 0 });
    const abort = new AbortController();
    reader.on('SIGINT', () => abort.abort());
    reader.on('close', () => abort.abort());
    try {
        output.write('New password (hidden): ');
        const password = await reader.question('', { signal: abort.signal });
        output.write('\nConfirm password (hidden): ');
        const confirmation = await reader.question('', { signal: abort.signal });
        if (password !== confirmation) throw new Error('Passwords did not match. Run the command again.');
        if (!validPasswordInput(password)) throw new Error(`Use a nonempty password of at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
        return password;
    } finally {
        reader.close();
        silentOutput.end();
        output.write('\n');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        if (process.argv.length !== 2) throw new Error('Do not pass a password as an argument. Run npm run hash-password.');
        const password = await promptForPassword();
        const passwordHash = await generatePasswordHash(password);
        process.stderr.write('Set SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH to the following complete line, without quotes:\n');
        process.stdout.write(`${passwordHash}\n`);
        process.stderr.write('Remove SILLYTAVERN_BASICAUTHUSER_PASSWORD from Railway, then deploy.\n');
    } catch (error) {
        // Do not print native-library errors or inputs, which could contain sensitive values.
        const message = error.name === 'AbortError' ? 'Cancelled.'
            : error.message.startsWith('Run ') || error.message.startsWith('Do not ')
                || error.message.startsWith('Passwords ') || error.message.startsWith('Use ')
                ? error.message : 'Could not generate the hash. Check that dependencies are installed.';
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
