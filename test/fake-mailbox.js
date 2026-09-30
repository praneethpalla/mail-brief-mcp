// A made-up mailbox for offline tests: behaves like the Session/MailClient pair in src/mail.js.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export async function buildEmail(fields) {
    return new MailComposer(fields).compile().build();
}

function matches(raw, criterion) {
    const text = raw.toString('utf8').toLowerCase();
    const header = text.split(/\r?\n\r?\n/)[0];
    const [key, ...args] = Array.isArray(criterion) ? criterion : [criterion];
    switch (String(key).toUpperCase()) {
        case 'ALL': return true;
        case 'UNSEEN': return null;  // handled with flags by the caller
        case 'SUBJECT': return /^subject:.*$/m.test(header) && header.match(/^subject:.*$/m)[0].includes(String(args[0]).toLowerCase());
        case 'FROM': return /^from:.*$/m.test(header) && header.match(/^from:.*$/m)[0].includes(String(args[0]).toLowerCase());
        case 'BODY': return text.slice(header.length).includes(String(args[0]).toLowerCase());
        case 'HEADER': return header.includes(String(args[1]).toLowerCase());
        case 'SINCE': case 'BEFORE': {
            const date = new Date((header.match(/^date:(.*)$/m) || [])[1]);
            return key.toUpperCase() === 'SINCE' ? date >= args[0] : date < args[0];
        }
        case 'OR': return matches(raw, args[0]) || matches(raw, args[1]);
        default: throw new Error(`fake mailbox: unsupported search ${key}`);
    }
}

export class FakeMailbox {
    constructor({ uidplus = true } = {}) {
        this.folders = { INBOX: new Map(), Drafts: new Map() };
        this.nextUid = 100;
        this.uidplus = uidplus;
        this.connections = 0;
        this.current = null;
    }

    add(folder, raw, flags = []) {
        const uid = this.nextUid++;
        this.folders[folder].set(uid, { raw: Buffer.from(raw), flags: [...flags] });
        return uid;
    }

    // MailClient interface
    async withConnection(fn) {
        this.connections++;
        return fn(this.session());
    }

    close() {}

    session() {
        const box = () => this.folders[this.current];
        return {
            openBox: async (folder) => {
                if (!this.folders[folder]) throw new Error(`Couldn't open folder "${folder}": no such folder`);
                this.current = folder;
            },
            search: async (criteria) => {
                const out = [];
                for (const [uid, m] of box()) {
                    const ok = criteria.every(c => {
                        if (c === 'UNSEEN') return !m.flags.includes('\\Seen');
                        return matches(m.raw, c);
                    });
                    if (ok) out.push(uid);
                }
                return out.sort((a, b) => a - b);
            },
            fetch: async (uids, { headersOnly = false } = {}) => uids
                .filter(uid => box().has(uid))
                .map(uid => {
                    const m = box().get(uid);
                    const raw = headersOnly ? Buffer.from(m.raw.toString('utf8').split(/\r?\n\r?\n/)[0] + '\r\n\r\n') : m.raw;
                    return { uid, flags: m.flags, size: m.raw.length, raw };
                }),
            getBoxes: async () => ({
                INBOX: { attribs: [], delimiter: '/' },
                Drafts: { attribs: ['\\Drafts'], special_use_attrib: '\\Drafts', delimiter: '/' }
            }),
            append: async (raw, { mailbox, flags }) => {
                const uid = this.add(mailbox, raw, flags);
                return this.uidplus ? uid : undefined;
            },
            addFlags: async (uids, flag) => { for (const u of uids) box().get(u)?.flags.push(flag); },
            expunge: async (uids) => { for (const u of uids) if (box().get(u)?.flags.includes('\\Deleted')) box().delete(u); },
            serverSupports: (cap) => cap === 'UIDPLUS' && this.uidplus
        };
    }
}
