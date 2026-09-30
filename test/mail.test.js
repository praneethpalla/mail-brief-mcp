// Offline tests for the connection layer and startup checks. No network, no logins.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MailClient } from '../src/mail.js';
import { configurationProblems } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
    delete process.env.MAIL_PASSWORD_COMMAND;
    delete process.env.IMAP_LEASE_TIMEOUT_MS;
});

function fakeClient() {
    const client = new MailClient();
    const stats = { logins: 0, active: 0, maxActive: 0 };
    client.openConnection = async () => {
        stats.logins++;
        const conn = new EventEmitter();
        conn.state = 'authenticated';
        conn.getBoxes = (cb) => {
            stats.active++;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            setTimeout(() => { stats.active--; cb(null, {}); }, 15);
        };
        conn.end = () => { conn.state = 'disconnected'; conn.emit('end'); };
        return conn;
    };
    return { client, stats };
}

test('the password comes only from MAIL_PASSWORD_COMMAND, runs once, and errors hide its output', async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')), 'runs');
    process.env.MAIL_PASSWORD_COMMAND = `echo run >> "${counter}"; printf 'from-store\\n'`;
    const client = new MailClient();
    assert.equal(await client.getPassword(), 'from-store');
    assert.equal(await client.getPassword(), 'from-store');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);

    const failing = new MailClient();
    process.env.MAIL_PASSWORD_COMMAND = 'echo leaked-secret; exit 4';
    await assert.rejects(failing.getPassword(), (err) => /exit code 4/.test(err.message) && !err.message.includes('secret'));

    delete process.env.MAIL_PASSWORD_COMMAND;
    await assert.rejects(new MailClient().getPassword(), /MAIL_PASSWORD_COMMAND is not set/);
});

test('calls share one login and take turns on the connection', async () => {
    const { client, stats } = fakeClient();
    await Promise.all([1, 2, 3].map(() => client.withConnection(s => s.getBoxes())));
    assert.equal(stats.logins, 1);
    assert.equal(stats.maxActive, 1);
    client.close();
});

test('a session refuses use after its call finishes', async () => {
    const { client } = fakeClient();
    let leaked;
    await client.withConnection(async (s) => { leaked = s; });
    assert.throws(() => leaked.getBoxes(), /used after it was released/);
    client.close();
});

test('a call that overruns the lease gets its connection closed, and the next call logs in fresh', async () => {
    process.env.IMAP_LEASE_TIMEOUT_MS = '30';
    const { client, stats } = fakeClient();
    let firstConn;
    const stuck = client.withConnection(async () => {
        firstConn = client.conn;
        await new Promise(r => setTimeout(r, 80));
    });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(firstConn.state, 'disconnected', 'the stuck connection was closed');
    await client.withConnection(s => s.getBoxes());
    assert.equal(stats.logins, 2);
    await stuck;
    client.close();
});

test('unsafe or incomplete configuration is refused', () => {
    assert.deepEqual(configurationProblems({ MAIL_ADDRESS: 'a@b.c', MAIL_PASSWORD_COMMAND: 'x' }), []);
    const problems = configurationProblems({ MAIL_PASSWORD: 'hunter2', YAHOO_APP_PASSWORD: 'x' });
    assert.equal(problems.length, 4);
    assert.ok(problems.some(p => /MAIL_PASSWORD is set, but plain-text passwords are not supported/.test(p)));
    assert.ok(problems.some(p => /MAIL_ADDRESS is not set/.test(p)));
    assert.ok(!problems.join(' ').includes('hunter2'), 'the password value is never printed');
});

test('the server refuses to start with a plain-text password', async () => {
    const proc = spawn(process.execPath, ['src/server.js'], {
        cwd: root,
        env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', MAIL_ADDRESS: 'a@example.com', MAIL_PASSWORD: 'Zq9-dummy', MAIL_PASSWORD_COMMAND: 'printf x' }
    });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    const code = await new Promise(r => proc.on('exit', r));
    assert.equal(code, 1);
    assert.match(err, /Refusing to start: MAIL_PASSWORD is set/);
    assert.ok(!err.includes('Zq9-dummy'));
});
