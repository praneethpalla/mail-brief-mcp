/** Microsoft device sign-in and refresh. Tokens are never written to project files. */
export const OUTLOOK_SCOPE = 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All';

export class OutlookOAuth {
    constructor({ clientId, tenant = 'consumers', readRefreshToken, saveRefreshToken,
        fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
        if (!clientId) throw new Error('OUTLOOK_CLIENT_ID is required');
        if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new Error('Invalid OUTLOOK_TENANT');
        Object.assign(this, { clientId, readRefreshToken, saveRefreshToken, fetchImpl, sleep, now });
        this.endpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
    }

    async request(route, fields) {
        let response, data;
        try {
            response = await this.fetchImpl(`${this.endpoint}/${route}`, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: this.clientId, ...fields }),
                signal: AbortSignal.timeout(30000)
            });
            data = await response.json();
        } catch {
            throw new Error('Microsoft OAuth request failed. Check your network and retry.');
        }
        if (!response.ok || data.error) {
            const code = ['authorization_pending', 'slow_down', 'authorization_declined', 'expired_token',
                'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope', 'access_denied'].includes(data.error)
                ? data.error : 'oauth_error';
            const err = new Error(`Microsoft sign-in failed (${code}). Check app registration or run outlook:login again.`);
            err.code = code;
            throw err;
        }
        return data;
    }

    async accept(data) {
        if (typeof data.access_token !== 'string' || !data.access_token ||
            !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
            throw new Error('Microsoft returned an invalid token response');
        }
        if (data.refresh_token) await this.saveRefreshToken(data.refresh_token);
        return data;
    }

    async refresh() {
        const refreshToken = await this.readRefreshToken();
        if (!refreshToken) throw new Error('No Microsoft refresh token found. Run npm run outlook:login first.');
        return this.accept(await this.request('token', {
            grant_type: 'refresh_token', refresh_token: refreshToken, scope: OUTLOOK_SCOPE
        }));
    }

    async login(showInstructions) {
        const device = await this.request('devicecode', { scope: OUTLOOK_SCOPE });
        if (!device.device_code || !device.user_code || !device.verification_uri ||
            !Number.isFinite(Number(device.expires_in)) || Number(device.expires_in) <= 0) {
            throw new Error('Microsoft returned an invalid device-code response');
        }
        showInstructions(`Visit ${device.verification_uri} and enter ${device.user_code}. Sign in with the account configured as MAIL_ADDRESS.`);
        const deadline = this.now() + Number(device.expires_in) * 1000;
        let interval = Math.max(Number(device.interval) || 5, 1) * 1000;
        while (this.now() < deadline) {
            await this.sleep(interval);
            if (this.now() >= deadline) break;
            try {
                const data = await this.request('token', {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code
                });
                if (!data.refresh_token) throw new Error('Microsoft did not return a refresh token');
                return await this.accept(data);
            } catch (err) {
                if (err.code === 'slow_down') interval += 5000;
                else if (err.code !== 'authorization_pending') throw err;
            }
        }
        throw new Error('Microsoft sign-in expired. Run npm run outlook:login again.');
    }
}
