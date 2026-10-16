import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MailBrief } from '../src/server.js';
import { FakeMailbox, buildEmail } from './fake-mailbox.js';
import { isPublicAddress, unsubscribeOptions, postOneClick } from '../src/unsubscribe.js';
import { simpleParser } from 'mailparser';

afterEach(() => { delete process.env.READ_ONLY; delete process.env.JUNK_FOLDER; });
async function setup(headers = {}, options = {}) {
    const mailbox = new FakeMailbox(options);
    const uid = mailbox.add('INBOX', await buildEmail({from:'news@example.com',to:'me@example.com',subject:'Newsletter',text:'News',headers}));
    const calls = [];
    const brief = new MailBrief(mailbox, { unsubscribePost: async url => { calls.push(url); return {status:202}; } });
    return {mailbox,uid,brief,calls};
}
const headers = { 'List-Unsubscribe':'<https://news.example/unsubscribe?id=secret>, <mailto:leave@news.example>', 'List-Unsubscribe-Post':'List-Unsubscribe=One-Click' };

test('unsubscribe preview uses headers without contacting endpoints or marking read', async () => {
    const f = await setup(headers);
    const options = JSON.parse((await f.brief.getUnsubscribeOptions({uid:f.uid})).content[0].text);
    assert.equal(options.oneClickUrl,'https://news.example/unsubscribe?id=secret');
    assert.equal(options.options.length,2);
    assert.deepEqual(f.calls,[]);
    assert.deepEqual(f.mailbox.folders.INBOX.get(f.uid).flags,[]);
});

test('unsubscribe requires explicit authorization and exact header URL', async () => {
    const f = await setup(headers);
    await assert.rejects(f.brief.unsubscribeEmail({uid:f.uid}), /authorization/);
    await assert.rejects(f.brief.unsubscribeEmail({uid:f.uid,confirmed:true,url:'https://other.example'}), /does not match/);
    assert.equal(f.calls.length,0);
    const result = await f.brief.unsubscribeEmail({uid:f.uid,confirmed:true,url:'https://news.example/unsubscribe?id=secret'});
    assert.match(result.content[0].text,/accepted \(HTTP 202\)/);
    assert.equal(f.calls.length,1);
    assert.ok(f.mailbox.folders.INBOX.has(f.uid));
});

test('manual-only and missing unsubscribe headers never trigger HTTP', async () => {
    for (const h of [{}, {'List-Unsubscribe':'<mailto:leave@news.example>'}, {'List-Unsubscribe':'<https://news.example/unsubscribe>'}]) {
        const f = await setup(h);
        await assert.rejects(f.brief.unsubscribeEmail({uid:f.uid,confirmed:true,url:'https://news.example/unsubscribe'}), /does not advertise/);
        assert.equal(f.calls.length,0);
    }
    const parsed = await simpleParser(await buildEmail({from:'a@example.com',text:'<https://evil.example>',headers:{'List-Unsubscribe':'<https://user:pass@evil.example>, <javascript:bad>'}}));
    assert.deepEqual(unsubscribeOptions(parsed),{options:[],oneClickUrl:null});
});

test('move to Junk moves only selected messages and retains unread status', async () => {
    const f = await setup();
    const other = f.mailbox.add('INBOX',await buildEmail({from:'friend@example.com',text:'Hi'}));
    const result = await f.brief.moveToJunk({uids:[f.uid]});
    assert.match(result.content[0].text,/Moved 1 email/);
    assert.ok(!f.mailbox.folders.INBOX.has(f.uid));
    assert.ok(f.mailbox.folders.INBOX.has(other));
    assert.equal(f.mailbox.folders.Junk.size,1);
    assert.deepEqual([...f.mailbox.folders.Junk.values()][0].flags,[]);
});

test('move preflight refuses missing UIDs, wrong folder, unsupported MOVE and duplicates', async () => {
    const f = await setup();
    await assert.rejects(f.brief.moveToJunk({uids:[f.uid,999]}),/nothing was moved/);
    await assert.rejects(f.brief.moveToJunk({uids:[f.uid,f.uid]}),/Duplicate/);
    await assert.rejects(f.brief.moveToJunk({uids:[f.uid],folder:'Junk'}),/already/);
    process.env.JUNK_FOLDER='missing';
    await assert.rejects(f.brief.moveToJunk({uids:[f.uid]}),/Junk folder not found/);
    delete process.env.JUNK_FOLDER;
    const noMove = await setup({}, {move:false});
    await assert.rejects(noMove.brief.moveToJunk({uids:[noMove.uid]}),/native IMAP MOVE/);
    assert.equal(f.mailbox.folders.Junk.size,0);
});

test('READ_ONLY prevents unsubscribe and Junk mutations before connecting', async () => {
    const f = await setup(headers);
    process.env.READ_ONLY='true';
    await assert.rejects(f.brief.moveToJunk({uids:[f.uid]}),/READ_ONLY/);
    await assert.rejects(f.brief.unsubscribeEmail({uid:f.uid,confirmed:true}),/READ_ONLY/);
    assert.equal(f.mailbox.connections,0);
    assert.equal(f.calls.length,0);
});

test('unsubscribe blocks private, reserved, mapped and non-global IP addresses', async () => {
    for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','0.0.0.0','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
    assert.equal(isPublicAddress('8.8.8.8'),true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
    const request = () => { throw new Error('Must not request'); };
    for (const url of ['http://news.example/u','https://user:pass@news.example/u','https://news.example:8443/u','https://news.example/u#x']) await assert.rejects(postOneClick(url,{request}),/requires HTTPS/);
    await assert.rejects(postOneClick('https://news.example/u',{resolve:async()=>[{address:'127.0.0.1',family:4}],request}),/public Internet/);
    await assert.rejects(postOneClick('https://news.example/u',{resolve:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],request}),/public Internet/);
});

test('unsubscribe pins DNS, sends only POST form data, and never follows redirects', async () => {
    for (const status of [204,302,500]) {
        let sent;
        const request = (url,options,callback) => {
            assert.equal(options.method,'POST');
            assert.equal(options.agent,false);
            assert.equal(options.rejectUnauthorized,true);
            assert.equal(options.headers.Authorization,undefined);
            assert.equal(options.headers.Cookie,undefined);
            options.lookup('news.example',{},(err,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});
            const req = new EventEmitter();
            req.end = payload => { sent=payload; queueMicrotask(()=>callback({statusCode:status,destroy(){}})); };
            req.destroy = () => req.emit('error',new Error('network secret'));
            return req;
        };
        const operation=postOneClick('https://news.example/u',{resolve:async()=>[{address:'8.8.8.8',family:4}],request});
        if (status===204) assert.deepEqual(await operation,{status:204});
        else await assert.rejects(operation,/no redirect was followed/);
        assert.equal(sent,'List-Unsubscribe=One-Click');
    }
});
