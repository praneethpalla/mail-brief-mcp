/** Explicitly requested HTTPS one-click unsubscribe. No SMTP or browser automation. */
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
    ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
    ['192.88.99.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
blocked.addSubnet('2001:db8::',32,'ipv6');
blocked.addSubnet('2001::',23,'ipv6');
blocked.addSubnet('2002::',16,'ipv6');

export function isPublicAddress(address) {
    const family = isIP(address);
    if (family === 4) return !blocked.check(address,'ipv4');
    // Only global unicast; excludes loopback, link-local, ULA, mapped IPv4 and multicast.
    if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address,'ipv6');
    return false;
}

function header(parsed, name) {
    return (parsed.headerLines || []).filter(h => h.key.toLowerCase() === name)
        .map(h => h.line.slice(h.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g,' ').trim());
}

export function unsubscribeOptions(parsed) {
    const list = header(parsed, 'list-unsubscribe');
    const post = header(parsed, 'list-unsubscribe-post');
    const urls = list.flatMap(value => [...value.matchAll(/<([^<>]+)>/g)].map(m => m[1].trim()))
        .filter(value => value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value));
    const options = [];
    for (const value of [...new Set(urls)]) {
        let url;
        try { url = new URL(value); } catch { continue; }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) continue;
        options.push({ url: url.href, method: url.protocol === 'mailto:' ? 'email' : 'web' });
    }
    const httpsOptions = options.filter(o => o.url.startsWith('https:'));
    const oneClick = list.length === 1 && post.length === 1 &&
        /^List-Unsubscribe\s*=\s*One-Click$/i.test(post[0]) && httpsOptions.length === 1;
    return { options, oneClickUrl: oneClick ? httpsOptions[0].url : null };
}

export function validateUnsubscribeUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid unsubscribe URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        (url.port && url.port !== '443') || value.length > 8192) {
        throw new Error('One-click unsubscribe requires HTTPS on port 443 without credentials or fragments');
    }
    return url;
}

export async function postOneClick(value, { resolve = lookup, request = https.request } = {}) {
    const url = validateUnsubscribeUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g,'');
    let addresses;
    try { addresses = await resolve(hostname, { all: true, verbatim: true }); }
    catch { throw new Error('Unsubscribe DNS lookup failed'); }
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
        throw new Error('Unsubscribe endpoint must resolve only to public Internet addresses');
    }
    const pinned = addresses[0];
    const payload = 'List-Unsubscribe=One-Click';
    return new Promise((resolveResult, reject) => {
        let timer;
        const req = request(url, {
            method: 'POST', agent: false, family: pinned.family, minVersion: 'TLSv1.2', rejectUnauthorized: true,
            lookup: (_host, options, callback) => callback(null, options?.all ? [pinned] : pinned.address, pinned.family),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
        }, response => {
            clearTimeout(timer);
            // Do not follow redirects, return response content, retain cookies, or send authorization.
            const status = response.statusCode;
            response.destroy();
            if (status >= 200 && status < 300) resolveResult({ status });
            else reject(new Error(`Unsubscribe endpoint returned HTTP ${status}; no redirect was followed. Use the mail app for manual unsubscribe.`));
        });
        timer = setTimeout(() => req.destroy(new Error('timeout')), 15000);
        req.on('error', () => { clearTimeout(timer); reject(new Error('Unsubscribe request failed or timed out. It may have reached the sender; check before retrying.')); });
        req.end(payload);
    });
}
