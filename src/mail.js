/**
 * IMAP access for mail-brief-mcp.
 *
 * - Works with any IMAP provider (IMAP_HOST / IMAP_PORT; defaults to Yahoo).
 * - The password is only ever read through MAIL_PASSWORD_COMMAND (a password store such as the macOS
 *   Keychain), kept in memory, and re-read after a failed login. Plain-text passwords are refused.
 * - One shared login: tool calls take turns on a single connection (IMAP is stateful, so a lock plus a
 *   per-call SELECT keeps calls from seeing each other's folder). A call that holds it too long gets the
 *   connection closed rather than shared. The connection logs out after a period of no use.
 */

import Imap from 'imap';
import { exec } from 'child_process';

export const DEFAULT_IMAP_HOST = 'imap.mail.yahoo.com';

export class MailClient {
    constructor() {
        this.conn = null;
        this.lock = Promise.resolve();
        this.idleTimer = null;
        this.passwordCache = null;
    }

    // ------------------------------------------------------------------
    // Credentials and connecting
    // ------------------------------------------------------------------

    async getPassword() {
        const command = process.env.MAIL_PASSWORD_COMMAND;
        if (!command) {
            throw new Error('MAIL_PASSWORD_COMMAND is not set. The password must come from a password store; see README.');
        }
        if (this.passwordCache) return this.passwordCache;

        const output = await new Promise((resolve, reject) => {
            // Long timeout: the password store may ask the user to approve (e.g. Keychain "Allow")
            exec(command, { timeout: 120000, windowsHide: true }, (err, stdout) => {
                if (err) {
                    // Never include the command's output in errors: it could contain the secret
                    reject(new Error(`MAIL_PASSWORD_COMMAND failed (${err.killed ? 'timed out' : `exit code ${err.code}`}). ` +
                        'Check the command, and allow access if your password store asked.'));
                    return;
                }
                resolve(stdout);
            });
        });
        const password = output.replace(/\r?\n$/, '');
        if (!password) throw new Error('MAIL_PASSWORD_COMMAND printed nothing');
        this.passwordCache = password;
        return password;
    }

    async openConnection() {
        if (!process.env.MAIL_ADDRESS) throw new Error('MAIL_ADDRESS is not set');
        const password = await this.getPassword();
        const host = process.env.IMAP_HOST || DEFAULT_IMAP_HOST;

        return new Promise((resolve, reject) => {
            const imap = new Imap({
                user: process.env.MAIL_ADDRESS,
                password,
                host,
                port: Number(process.env.IMAP_PORT) || 993,
                tls: process.env.IMAP_TLS !== 'false',
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: { rejectUnauthorized: true, servername: host, minVersion: 'TLSv1.2' }
            });
            const timer = setTimeout(() => {
                imap.end();
                reject(new Error('Connection to the mail server timed out'));
            }, 35000);
            imap.once('ready', () => { clearTimeout(timer); resolve(imap); });
            imap.once('error', (err) => {
                clearTimeout(timer);
                if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(err.message)) {
                    this.passwordCache = null;  // re-read from the password store next time (e.g. after rotation)
                    reject(new Error(`Login failed: ${err.message}. Check the app password in your password store.`));
                } else {
                    reject(new Error(`Mail server connection failed: ${err.message}`));
                }
            });
            imap.connect();
        });
    }

    async sharedConnection() {
        if (this.conn && this.conn.state === 'authenticated') return this.conn;
        this.conn = null;
        const conn = await this.openConnection();
        const drop = () => { if (this.conn === conn) this.conn = null; };
        conn.on('error', (err) => { console.error('[IMAP] Connection error:', err.message); drop(); });
        conn.once('end', drop);
        conn.once('close', drop);
        this.conn = conn;
        return conn;
    }

    scheduleIdleLogout() {
        clearTimeout(this.idleTimer);
        const idleMs = Number(process.env.IMAP_IDLE_MS) || 5 * 60 * 1000;
        this.idleTimer = setTimeout(() => {
            if (this.conn) { this.conn.end(); this.conn = null; }
        }, idleMs);
        this.idleTimer.unref?.();
    }

    // ------------------------------------------------------------------
    // Taking turns on the shared connection
    // ------------------------------------------------------------------

    /**
     * Run fn(session) with exclusive use of the connection. The session refuses use after fn finishes,
     * and a call that overruns IMAP_LEASE_TIMEOUT_MS gets the connection closed instead of shared.
     */
    async withConnection(fn) {
        let release;
        const previous = this.lock;
        this.lock = new Promise(resolve => { release = resolve; });
        await previous;
        clearTimeout(this.idleTimer);

        let conn;
        try {
            conn = await this.sharedConnection();
        } catch (err) {
            release();
            throw err;
        }

        let released = false;
        const done = () => {
            if (released) return;
            released = true;
            clearTimeout(timer);
            this.scheduleIdleLogout();
            release();
        };
        const leaseMs = Number(process.env.IMAP_LEASE_TIMEOUT_MS) || 5 * 60 * 1000;
        const timer = setTimeout(() => {
            console.error('[IMAP] A call held the connection too long; closing it');
            if (this.conn === conn) this.conn = null;
            try { (conn.destroy || conn.end).call(conn); } catch { /* already closed */ }
            done();
        }, leaseMs);

        const session = new Session(conn, () => released);
        try {
            return await fn(session);
        } finally {
            done();
        }
    }

    close() {
        clearTimeout(this.idleTimer);
        if (this.conn) { this.conn.end(); this.conn = null; }
    }
}

/**
 * Promise helpers over one IMAP connection for the duration of a single tool call
 */
export class Session {
    constructor(conn, isReleased) {
        this.conn = conn;
        this.isReleased = isReleased;
    }

    call(method, ...args) {
        if (this.isReleased()) throw new Error(`IMAP connection used after it was released (${method})`);
        return new Promise((resolve, reject) => {
            this.conn[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
        });
    }

    openBox(folder, readOnly = true) {
        return this.call('openBox', folder, readOnly).catch(err => {
            throw new Error(`Couldn't open folder "${folder}": ${err.message}`);
        });
    }

    search(criteria) { return this.call('search', criteria); }
    getBoxes() { return this.call('getBoxes'); }
    append(raw, options) { return this.call('append', raw, options); }
    addFlags(uids, flag) { return this.call('addFlags', uids, flag); }
    expunge(uids) { return this.call('expunge', uids); }
    move(uids, folder) { return this.call('move', uids, folder); }
    serverSupports(capability) { return this.conn.serverSupports(capability); }

    /**
     * Fetch messages by UID (array). Returns [{ uid, flags, size, raw }] in the order requested.
     * Uses BODY.PEEK, so messages are not marked as read.
     */
    fetch(uids, { headersOnly = false } = {}) {
        if (this.isReleased()) throw new Error('IMAP connection used after it was released (fetch)');
        if (!uids.length) return Promise.resolve([]);
        return new Promise((resolve, reject) => {
            const bodies = headersOnly
                ? 'HEADER.FIELDS (FROM TO SUBJECT DATE REPLY-TO LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)'
                : '';
            const f = this.conn.fetch(uids, { bodies, size: true });
            const messages = [];
            const pending = [];
            f.on('message', (msg) => {
                const chunks = [];
                let attrs = {};
                const done = new Promise((resolveMsg) => {
                    msg.on('body', (stream) => stream.on('data', (chunk) => chunks.push(chunk)));
                    msg.once('attributes', (a) => { attrs = a; });
                    msg.once('end', () => {
                        messages.push({ uid: attrs.uid, flags: attrs.flags || [], size: attrs.size || 0, raw: Buffer.concat(chunks) });
                        resolveMsg();
                    });
                });
                pending.push(done);
            });
            f.once('error', reject);
            f.once('end', async () => {
                await Promise.all(pending);
                const order = new Map(uids.map((uid, i) => [Number(uid), i]));
                messages.sort((a, b) => (order.get(a.uid) ?? 0) - (order.get(b.uid) ?? 0));
                resolve(messages);
            });
        });
    }
}
