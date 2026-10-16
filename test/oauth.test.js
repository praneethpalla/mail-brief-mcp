import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OutlookOAuth, OUTLOOK_SCOPE } from '../src/oauth.js';
import { MailClient, imapHost, xoauth2, enableOAuthLogin } from '../src/mail.js';
import { configurationProblems } from '../src/server.js';

const savedEnv = { ...process.env };
afterEach(() => {
    for (const key of ['MAIL_AUTH', 'MAIL_OAUTH_TOKEN_COMMAND', 'MAIL_ADDRESS']) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});
function fixture(responses) {
    const calls = [], saved = [], waits = [];
    let clock = 0;
    const oauth = new OutlookOAuth({ clientId: 'client', readRefreshToken: async () => 'refresh-secret',
        saveRefreshToken: async token => saved.push(token), now: () => clock,
        sleep: async ms => { waits.push(ms); clock += ms; },
        fetchImpl: async (url, options) => {
            calls.push({ url, fields: Object.fromEntries(options.body) });
            const data = responses.shift();
            assert.ok(data, 'unexpected request');
            return { ok: !data.error, json: async () => data };
        }
    });
    return { oauth, calls, saved, waits };
}
const token = { access_token: 'access-secret', expires_in: 3600, refresh_token: 'rotated-secret' };

test('refresh requests only IMAP scope and stores rotated refresh token', async () => {
    const f = fixture([token]);
    assert.equal((await f.oauth.refresh()).access_token, 'access-secret');
    assert.deepEqual(f.saved, ['rotated-secret']);
    assert.equal(f.calls[0].fields.refresh_token, 'refresh-secret');
    assert.equal(f.calls[0].fields.scope, OUTLOOK_SCOPE);
    assert.match(f.calls[0].url, /\/consumers\/oauth2\/v2.0\/token$/);
    assert.ok(!OUTLOOK_SCOPE.includes('SMTP'));
});

test('device sign-in polls pending, slows down, and saves refresh token', async () => {
    const f = fixture([{ device_code: 'device-secret', user_code: 'CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 100, interval: 1 },
        { error: 'authorization_pending' }, { error: 'slow_down' }, token]);
    let message;
    await f.oauth.login(m => { message = m; });
    assert.match(message, /CODE/);
    assert.ok(!message.includes('device-secret'));
    assert.deepEqual(f.waits, [1000, 1000, 6000]);
    assert.deepEqual(f.saved, ['rotated-secret']);
});

test('OAuth errors hide provider response and tokens; declined sign-in stops', async () => {
    const f = fixture([{ error: 'invalid_grant', error_description: 'refresh-secret' }]);
    await assert.rejects(f.oauth.refresh(), err => /invalid_grant/.test(err.message) && !err.message.includes('secret'));
    const declined = fixture([{ device_code: 'd', user_code: 'c', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 100 }, { error: 'authorization_declined' }]);
    await assert.rejects(declined.oauth.login(() => {}), /authorization_declined/);
    assert.equal(declined.calls.length, 2);
});

test('expired device sign-in stops without requesting a token', async () => {
    const f = fixture([{ device_code: 'd', user_code: 'c', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 1, interval: 5 }]);
    await assert.rejects(f.oauth.login(() => {}), /expired/);
    assert.equal(f.calls.length, 1);
});

test('OAuth configuration uses Outlook host, requires token helper and TLS', () => {
    assert.equal(imapHost({}), 'imap.mail.yahoo.com');
    assert.equal(imapHost({ MAIL_AUTH: 'oauth2' }), 'outlook.office365.com');
    assert.equal(imapHost({ MAIL_AUTH: 'oauth2', IMAP_HOST: 'custom' }), 'custom');
    assert.deepEqual(configurationProblems({ MAIL_ADDRESS: 'me@outlook.com', MAIL_AUTH: 'oauth2', MAIL_OAUTH_TOKEN_COMMAND: 'helper' }), []);
    assert.match(configurationProblems({ MAIL_ADDRESS: 'me@outlook.com', MAIL_AUTH: 'oauth2', IMAP_TLS: 'false' }).join(' '), /MAIL_OAUTH_TOKEN_COMMAND.*OAuth requires/);
    assert.match(configurationProblems({ MAIL_AUTH: 'typo' }).join(' '), /MAIL_AUTH must/);
});

test('OAuth produces XOAUTH2 without a password, caches until expiry, hides helper failures', async () => {
    process.env.MAIL_AUTH = 'oauth2';
    process.env.MAIL_ADDRESS = 'me@outlook.com';
    process.env.MAIL_OAUTH_TOKEN_COMMAND = `printf '%s' '{"access_token":"test-token","expires_in":3600}'`;
    const client = new MailClient();
    const auth = await client.authentication();
    assert.deepEqual(auth, { xoauth2: Buffer.from('user=me@outlook.com\x01auth=Bearer test-token\x01\x01').toString('base64') });
    process.env.MAIL_OAUTH_TOKEN_COMMAND = 'echo secret; exit 4';
    assert.equal(await client.getOAuthToken(), 'test-token');
    client.tokenCache.expiresAt = 0;
    await assert.rejects(client.getOAuthToken(), err => !err.message.includes('secret'));
    process.env.MAIL_OAUTH_TOKEN_COMMAND = `printf '%s' '{"access_token":"secret","expires_in":0}'`;
    await assert.rejects(client.getOAuthToken(), /invalid token response/);
    assert.throws(() => xoauth2('me@outlook.com', 'bad\x01token'), /Invalid OAuth/);
});

test('Outlook LOGINDISABLED permits OAuth only on TLS with advertised XOAUTH2', () => {
    const imap = { state: 'connected', _sock: { encrypted: true },
        serverSupports: name => ['LOGINDISABLED', 'AUTH=XOAUTH2', 'UIDPLUS'].includes(name) };
    enableOAuthLogin(imap);
    assert.equal(imap.serverSupports('LOGINDISABLED'), false);
    assert.equal(imap.serverSupports('AUTH=XOAUTH2'), true);
    assert.equal(imap.serverSupports('UIDPLUS'), true);
    imap._sock.encrypted = false;
    assert.equal(imap.serverSupports('LOGINDISABLED'), true);
    imap._sock.encrypted = true;
    imap.state = 'authenticated';
    assert.equal(imap.serverSupports('LOGINDISABLED'), true);
    const noOAuth = { state: 'connected', _sock: { encrypted: true }, serverSupports: name => name === 'LOGINDISABLED' };
    enableOAuthLogin(noOAuth);
    assert.equal(noOAuth.serverSupports('LOGINDISABLED'), true);
});
