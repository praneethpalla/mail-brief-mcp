#!/usr/bin/env node
// macOS helper: stdout is reserved for access-token JSON in token mode.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { OutlookOAuth } from '../src/oauth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.resolve(root, process.env.ENV_FILE || '.env'), quiet: true });
const run = promisify(execFile);
async function keychain(args) {
    try { return (await run('/usr/bin/security', args, { timeout: 120000 })).stdout.replace(/\r?\n$/, ''); }
    catch { throw new Error('Microsoft token Keychain access failed. Allow access when prompted, or run outlook:login first.'); }
}
async function main() {
    if (process.platform !== 'darwin') throw new Error('This helper uses macOS Keychain. On other systems use MAIL_OAUTH_TOKEN_COMMAND with your own secure token helper.');
    if (!process.env.MAIL_ADDRESS) throw new Error('MAIL_ADDRESS is required');
    const mode = process.argv[2];
    if (!['login', 'token'].includes(mode)) throw new Error('Usage: node scripts/outlook-auth.js login|token');
    const account = process.env.MAIL_ADDRESS;
    const service = `mail-brief-mcp-outlook-${process.env.OUTLOOK_CLIENT_ID}`;
    const oauth = new OutlookOAuth({
        clientId: process.env.OUTLOOK_CLIENT_ID, tenant: process.env.OUTLOOK_TENANT || 'consumers',
        readRefreshToken: () => keychain(['find-generic-password', '-a', account, '-s', service, '-w']),
        saveRefreshToken: token => keychain(['add-generic-password', '-U', '-a', account, '-s', service, '-w', token])
    });
    if (mode === 'login') {
        await oauth.login(message => console.error(message));
        console.error('Microsoft sign-in saved in Keychain. You can now start the MCP server.');
    } else {
        const data = await oauth.refresh();
        process.stdout.write(JSON.stringify({ access_token: data.access_token, expires_in: data.expires_in }));
    }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
