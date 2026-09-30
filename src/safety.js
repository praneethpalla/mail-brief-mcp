/**
 * Safety hooks for mail-brief-mcp: automatic checks that warn or block, which the agent can't switch off.
 *
 *   readEmail   - every email read: payment red flags, Reply-To differing from the sender, display-name spoofing
 *   beforeDraft - before a reply draft is saved: warns when the reply goes to a Reply-To address, or when
 *                 the draft contains payment details
 *
 * Warnings are produced by the server and shown outside the untrusted-content block, so an email can't
 * fake or hide them. Custom rules: set SAFETY_HOOKS_MODULE to a JavaScript module exporting readEmail(ctx)
 * and/or beforeDraft(ctx), each returning { warnings?: string[], block?: string }. A failing custom hook
 * blocks the action (fails closed).
 */

import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Payment red flags
// ---------------------------------------------------------------------------

const PAYMENT_PATTERNS = [
    { label: 'a change of bank or payment details', re: /\b(new|updated?|changed?|different)\s+(bank(ing)?|account|payment|remittance|wire)\s+(details|information|info|instructions|account)\b|\b(bank(ing)?|account|payment)\s+(details|information)\s+(have|has)\s+(changed|been updated)\b/i },
    { label: 'an IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/ },
    { label: 'a SWIFT/BIC, routing, or sort code', re: /\b(swift|bic|aba|routing|sort\s*code|transit)\b[^\n]{0,20}?\b[A-Z0-9-]{6,11}\b/i },
    { label: 'a bank account number', re: /\b(account|acct|a\/c)\s*(no\.?|number|#)?\s*[:#]?\s*\d[\d\s-]{6,}\d\b/i },
    { label: 'a wire or bank transfer request', re: /\b(wire|bank|telegraphic|swift)\s+transfer\b|\bremit(tance)?\b|\bpay\s+(to|into)\s+(the\s+)?(following|this|new)\b/i },
    { label: 'gift cards', re: /\bgift\s*cards?\b|\b(itunes|google\s*play|steam|amazon)\s+(gift\s+)?cards?\b/i },
    { label: 'a cryptocurrency address or crypto payment', re: /\b(bc1[a-z0-9]{25,62}|0x[a-fA-F0-9]{40})\b|\b(bitcoin|btc|ethereum|eth|usdt|crypto)\b[^\n]{0,40}\b(wallet|address|payment|send)\b/i }
];
const URGENCY = /\b(urgent(ly)?|immediately|asap|today|within\s+\d+\s+hours?|overdue|final\s+notice|past\s+due|act\s+now|avoid\s+(suspension|penalt))/i;
const PAYMENT_WORDS = /\b(pay|payment|invoice|transfer|wire|remit|refund|deposit)\b/i;

export function paymentWarnings(text) {
    const found = PAYMENT_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);
    if (URGENCY.test(text) && PAYMENT_WORDS.test(text)) found.push('urgent pressure to pay');
    if (!found.length) return [];
    return [`Payment red flags: ${found.join(', ')}. Verify any payment request through a contact you already trust (not details from this email) before acting.`];
}

// ---------------------------------------------------------------------------
// Sender checks
// ---------------------------------------------------------------------------

const lower = (s) => String(s || '').toLowerCase();

export function senderWarnings({ from = [], replyTo = [] }) {
    const warnings = [];
    const fromAddresses = from.map(a => lower(a.address)).filter(Boolean);
    const replyAddresses = replyTo.map(a => lower(a.address)).filter(Boolean);

    const mismatched = replyAddresses.filter(a => !fromAddresses.includes(a));
    if (mismatched.length) {
        warnings.push(`Reply-To (${mismatched.join(', ')}) differs from the sender (${fromAddresses.join(', ') || 'unknown'}). Replies would go to the Reply-To address.`);
    }

    for (const a of from) {
        const shownAddress = (String(a.name || '').match(/[^\s<>"']+@[^\s<>"']+\.[a-z]{2,}/i) || [])[0];
        if (shownAddress && lower(shownAddress) !== lower(a.address)) {
            warnings.push(`The sender's display name shows "${shownAddress}", but the email actually comes from "${a.address}". This is a common impersonation trick.`);
        }
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

const BUILT_IN = {
    readEmail: (ctx) => ({
        warnings: [
            ...senderWarnings({ from: ctx.from, replyTo: ctx.replyTo }),
            ...paymentWarnings(`${ctx.subject || ''}\n${ctx.body || ''}`)
        ]
    }),
    beforeDraft: (ctx) => ({
        warnings: [
            ...(ctx.replyToMismatch ? [ctx.replyToMismatch] : []),
            ...paymentWarnings(`${ctx.subject || ''}\n${ctx.body || ''}`).map(w => `This draft contains ${w.charAt(0).toLowerCase()}${w.slice(1)}`)
        ]
    })
};

const customHooksCache = new Map();
async function customHooks() {
    const modulePath = process.env.SAFETY_HOOKS_MODULE;
    if (!modulePath) return {};
    const resolved = path.resolve(modulePath.replace(/^~(?=$|\/)/, os.homedir()));
    if (!customHooksCache.has(resolved)) {
        customHooksCache.set(resolved, import(pathToFileURL(resolved).href).then(m => m.default || m));
    }
    return customHooksCache.get(resolved);
}

/**
 * Run the built-in hook and any custom hook for an event. Returns { warnings, block }.
 */
export async function runHooks(event, ctx) {
    const results = [BUILT_IN[event] ? await BUILT_IN[event](ctx) : null];
    try {
        const custom = await customHooks();
        if (typeof custom[event] === 'function') results.push(await custom[event](ctx));
    } catch (err) {
        results.push({ block: `Custom safety hook "${event}" failed: ${err.message}` });
    }
    return {
        warnings: results.flatMap(r => (r && Array.isArray(r.warnings) ? r.warnings : [])),
        block: results.map(r => r && r.block).find(Boolean) || null
    };
}

export function formatWarnings(warnings) {
    if (!warnings || !warnings.length) return '';
    return warnings.map(w => `⚠️ Server safety check: ${w}`).join('\n') + '\n';
}
