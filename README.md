# mail-brief-mcp

A small, least-privilege MCP server for email. It does two jobs: help your AI assistant **summarize what arrived** and **draft replies for you to review**. Nothing else.

Works with any MCP client that runs local servers (Claude Desktop, Codex CLI, Cursor, VS Code, …) and any IMAP provider that offers app passwords (Yahoo by default; see [Providers](#providers)).

## Why so small

Every tool an agent has is something a malicious email can try to talk it into using. So this server leaves out everything the two jobs don't need:

| It can | It can't |
|---|---|
| List, search (including message text), and read emails, without marking them as read | Send anything |
| Save a **reply** draft, addressed from the original email | Draft to arbitrary addresses, or add attachments |
| Revise the text of **its own** reply drafts | Touch drafts you wrote yourself |
| | Delete, move, archive, or flag emails |
| | Download attachments |

The worst a fooled agent can do is leave a reply draft in your Drafts folder, which you'll see before anything happens.

## Tools

| Tool | What it does |
|---|---|
| `list_emails` | Recent emails in a folder, newest first: sender, subject, date, read status, and `automated` (newsletters, mailing lists, notifications). Options: `count` (max 50), `unreadOnly`, `since` |
| `search_emails` | Finds text in the subject, sender, **or body**, as **whole words** by default ("bill" doesn't match "billion"; `wholeWord: false` allows partial matches). Filters by `from`, `since`, `before`, `unreadOnly` |
| `read_email` | Up to 10 emails as the text a person would see, with sender content in untrusted-content blocks |
| `create_reply_draft` | A reply draft: recipients, `Re:` subject, and threading come from the original. Options: `replyAll`, `includeQuote` |
| `update_draft` | Replaces the reply text of a draft this server created; recipients and subject stay the same, and the quoted original is kept (`keepQuote: false` drops it). Returns the draft's new UID |

## Setup

### 1. Install

```bash
git clone https://github.com/praneethpalla/mail-brief-mcp.git
cd mail-brief-mcp
npm install
```

### 2. Create an app password and put it in a password store

Create an app password with your provider (see [Providers](#providers); Yahoo: [account security](https://login.yahoo.com/account/security) → Generate app password). Then store it; the server never reads a password from a file.

**macOS Keychain:**

```bash
# You'll be prompted for the password (hidden; it never lands in your shell history).
# -T "" trusts no app, so macOS asks you to Allow or Deny every read.
security add-generic-password -a you@yahoo.com -s mail-brief-mcp -T "" -w
```

**Windows Credential Manager:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-credential.ps1 -Set -User you@example.com
```

**Others:** any command that prints the password works, e.g. `op read "op://Private/Mail/password"` (1Password), `secret-tool lookup service mail-brief-mcp` (Linux keyrings), `pass show mail-brief-mcp`.

### 3. Configure

```bash
cp .env.example .env
```

```env
MAIL_ADDRESS=you@yahoo.com
MAIL_PASSWORD_COMMAND=security find-generic-password -a you@yahoo.com -s mail-brief-mcp -w
# IMAP_HOST=imap.mail.yahoo.com   (change for other providers)
```

### 4. Add it to your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mail-brief": {
      "command": "node",
      "args": ["/full/path/to/mail-brief-mcp/src/server.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.mail-brief]
command = "node"
args = ["/full/path/to/mail-brief-mcp/src/server.js"]
```

Restart the client and ask something like *"Summarize my unread emails from today"* or *"Draft a reply to Alice saying Friday works."* With the strict Keychain setting, macOS asks you to **Allow** access when the server first logs in.

## Providers

The server signs in with an **app password** over IMAP. Providers differ, and their policies change, so check yours:

| Provider | App passwords | `IMAP_HOST` | Notes |
|---|---|---|---|
| Yahoo | ✅ Yes (needs 2-step verification) | `imap.mail.yahoo.com` (default) | New accounts may not offer app passwords right away |
| AOL | ✅ Yes | `imap.aol.com` | Same system as Yahoo |
| iCloud Mail | ✅ Yes ("app-specific password", needs two-factor authentication) | `imap.mail.me.com` | |
| Fastmail | ✅ Yes | `imap.fastmail.com` | App passwords can be limited to mail access |
| Zoho Mail | ✅ Yes ("app-specific password") | `imap.zoho.com` | Region-specific hosts exist (e.g. `imap.zoho.eu`) |
| Gmail | ⚠️ Sometimes | `imap.gmail.com` | Only with 2-Step Verification on; often unavailable for work/school accounts. Google prefers OAuth |
| Outlook.com / Microsoft 365 | ❌ No | - | Microsoft requires OAuth for IMAP; not supported yet |
| Proton Mail | ⚠️ Via Proton Bridge | Bridge's local address | Bridge provides a local IMAP login; untested (it uses a local connection with its own certificate) |

Only Yahoo is planned for live testing so far; the others should work over standard IMAP but are untested. Outlook, and Gmail accounts without app passwords, would need OAuth sign-in, which isn't built yet.

**Dates** (`since`, `before`) are calendar days in your local time (`2026-10-01` means October 1 where you are) and use the date the email was sent.

## Security

**Where your password lives.** Only in your password store. The server refuses to start if a plain-text password is set (`MAIL_PASSWORD`, `IMAP_PASSWORD`, `YAHOO_APP_PASSWORD`), keeps the password in memory only, and never logs it. It logs in once and reuses the connection, logging out after 5 idle minutes.

**App passwords are powerful.** An app password usually grants full mailbox access, including sending over SMTP, even though this server never sends. Use one app password per setup, and **rotate it on a short schedule** and after testing. With Keychain, rotating is: generate a new app password, then run the `add-generic-password` command again with `-U`. The server re-reads it after the next failed login.

**Prompt injection.** Every email is text from a stranger, and it can contain instructions aimed at the AI. The server:

- returns everything the sender wrote inside `<untrusted-content>` blocks with random ids, which an email can't close early, plus a note telling the AI to treat it as data;
- shows only what a person would see: hidden HTML (`display:none`, zero-size or transparent text, off-screen elements, comments, scripts) and invisible Unicode are removed, and the HTML part is preferred over a plain-text part mail apps don't show;
- caps each email body (`READ_EMAIL_MAX_CHARS`, default 20,000 characters);
- labels tools with MCP hints (`readOnlyHint`, `destructiveHint`) so clients can ask before changes.

This reduces the risk; it can't eliminate it. Language models read your request and an email's text as one stream, so the real guarantees come from what the server *can't* do (see the table above) and from approving tool calls in your client.

**Safety hooks.** Automatic checks the agent can't switch off. Warnings come from the server, outside the untrusted block (`⚠️ Server safety check: …`):

- **Reading:** payment red flags (changed bank details, IBANs, account numbers, wire transfers, gift cards, crypto, urgency plus payment), a Reply-To that differs from the sender, and display-name spoofing such as `"support@paypal.com" <billing@evil.example>`.
- **Drafting:** a warning when a reply would go to a Reply-To address instead of the sender, or when the draft contains payment details.

Add your own rules with `SAFETY_HOOKS_MODULE`: a JavaScript module exporting `readEmail(ctx)` and/or `beforeDraft(ctx)` that return `{ warnings: [...], block: "reason" }`. If a custom hook throws, the action is blocked.

```js
// my-hooks.mjs: never draft replies about wire transfers
export function beforeDraft(ctx) {
    return /wire transfer/i.test(ctx.body) ? { block: 'Write replies about wire transfers by hand.' } : { warnings: [] };
}
```

**Read-only mode.** `READ_ONLY=true` removes the draft tools, so the server can't change anything at all.

## Settings

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAIL_ADDRESS` | Yes | - | Your email address (IMAP login) |
| `MAIL_PASSWORD_COMMAND` | Yes | - | Command that prints the app password from a password store |
| `IMAP_HOST` | No | `imap.mail.yahoo.com` | IMAP server |
| `IMAP_PORT` | No | `993` | IMAP port |
| `IMAP_TLS` | No | `true` | Set to `false` only for a local test server |
| `DRAFTS_FOLDER` | No | auto-detected | Drafts folder name (normally found from the server's `\Drafts` flag) |
| `READ_ONLY` | No | - | `true` removes the draft tools |
| `READ_EMAIL_MAX_CHARS` | No | `20000` | Maximum characters of each email body |
| `SEARCH_SCAN_LIMIT` | No | `100` | How many of the newest candidates a whole-word search checks |
| `SAFETY_HOOKS_MODULE` | No | - | Path to your custom safety hooks |
| `IMAP_IDLE_MS` | No | `300000` | Log out after this long without use |
| `IMAP_LEASE_TIMEOUT_MS` | No | `300000` | If one call holds the connection longer, the connection is closed and the next call logs in fresh |
| `ENV_FILE` | No | `.env` | Settings file to load, relative to the project folder |

## Project status

| Area | Status |
|---|---|
| All tools, security, and safety hooks | ✅ Covered by the offline test suite (`npm test`: a made-up mailbox, no real logins) |
| Live use with a real mailbox (Yahoo, Claude Desktop, Keychain) | ✅ Listing, unread filter, reading, search, reply draft, update, and refusing to delete all tested. Fixes from that test (local dates, whole-word search, keeping the quote on update, the `automated` label) are covered by offline tests |
| Providers other than Yahoo | ⚠️ Should work over standard IMAP with an app password; untested. Outlook / Microsoft 365 isn't supported (requires OAuth) |
| Windows Credential Manager script | ⚠️ Untested on Windows |

## Development

```bash
npm test
```

Tests never log in to a real account.

## Background

This server applies the lessons from building [yahoo-mail-mcp](https://github.com/praneethpalla/yahoo-mail-mcp), a full-featured Yahoo Mail MCP server: most real use came down to summarizing and drafting replies, and every extra tool was surface area an agent didn't need.

## License

MIT. See [LICENSE](LICENSE).
