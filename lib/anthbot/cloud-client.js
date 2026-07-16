'use strict';

const crypto = require('node:crypto');

const { modelNameByCategory } = require('./payload');
const { AnthbotGenieError, asInteger } = require('./utils');

/** Client for Anthbot cloud API interactions. */
class AnthbotCloudApiClient {
    /**
     * @param {object} config
     * @param {object} config.http
     * @param {string} config.host
     * @param {string|null} [config.bearerToken]
     */
    constructor({ http, host, bearerToken = null }) {
        this.http = http;
        this.host = host;
        this.bearerToken = bearerToken;
        this.authHeaders = {
            Accept: 'application/json, text/plain, */*',
            version: 'v2',
            language: 'en',
            'User-Agent': 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0',
        };
        if (bearerToken) {
            this.authHeaders.Authorization = bearerToken;
        }
    }

    /**
     * @param {{ username: string, password: string, areaCode: string }} params
     * @returns {Promise<string>}
     */
    async login({ username, password, areaCode }) {
        const response = await this.http.post(
            `https://${this.host}/api/v1/login`,
            {
                username,
                password,
                areaCode,
            },
            {
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    version: 'v2',
                    language: 'en',
                    'User-Agent': 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0',
                },
            },
        );
        const data = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Login failed (${response.status}): ${String(response.data).slice(0, 300)}`);
        }
        if (!data || typeof data !== 'object') {
            throw new AnthbotGenieError('Invalid login payload type');
        }
        if (data.code !== 0) {
            throw new AnthbotGenieError(`Login rejected: code=${JSON.stringify(data.code)}`);
        }
        const accessToken = data?.data?.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
            throw new AnthbotGenieError('Login payload missing access_token');
        }
        this.bearerToken = `Bearer ${accessToken}`;
        this.authHeaders.Authorization = this.bearerToken;
        return this.bearerToken;
    }

    /** Ensure the client has a bearer token. */
    requireToken() {
        if (!this.bearerToken) {
            throw new AnthbotGenieError('Bearer token not configured');
        }
    }

    /**
     * @param {string} serialNumber
     * @param {number|null} [timestamp]
     * @returns {string}
     */
    static buildVerificationToken(serialNumber, timestamp = null) {
        const unixTimestamp = timestamp || Math.floor(Date.now() / 1000);
        const tokenSuffix = String(unixTimestamp);
        const tokenPrefix = crypto.createHash('md5').update(`${serialNumber}${tokenSuffix}`, 'utf8').digest('hex');
        return `${tokenPrefix}${tokenSuffix}`;
    }

    /**
     * @returns {Promise<Array<object>>}
     */
    async getBoundDevices() {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/bind/list`, {
            headers: this.authHeaders,
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Bind list failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid bind list payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Bind list returned code=${JSON.stringify(payload.code)}`);
        }
        if (!Array.isArray(payload.data)) {
            throw new AnthbotGenieError('Bind list payload missing data array');
        }
        return payload.data
            .filter(item => item && typeof item === 'object' && typeof item.sn === 'string' && item.sn)
            .map(item => ({
                serialNumber: item.sn,
                alias: typeof item.alias === 'string' && item.alias ? item.alias : item.sn,
                model: modelNameByCategory(item.category_id),
                isOwner:
                    typeof item.is_owner === 'boolean'
                        ? item.is_owner
                        : typeof item.is_owner === 'number'
                          ? item.is_owner === 1
                          : null,
            }));
    }

    /**
     * @param {string} serialNumber
     * @returns {Promise<object>}
     */
    async getDeviceRegion(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/region`, {
            headers: this.authHeaders,
            params: { sn: serialNumber },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Device region failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid device region payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Device region returned code=${JSON.stringify(payload.code)}`);
        }
        const data = payload.data;
        if (!data || typeof data !== 'object') {
            throw new AnthbotGenieError('Device region payload missing data object');
        }
        if (typeof data.region_name !== 'string' || !data.region_name) {
            throw new AnthbotGenieError('Device region missing region_name');
        }
        if (typeof data.iot_endpoint !== 'string' || !data.iot_endpoint) {
            throw new AnthbotGenieError('Device region missing iot_endpoint');
        }
        return {
            serialNumber,
            regionName: data.region_name,
            iotEndpoint: data.iot_endpoint,
        };
    }

    /**
     * @param {string} serialNumber
     * @returns {Promise<object>}
     */
    async getDeviceIotCredentials(serialNumber) {
        this.requireToken();
        const response = await this.http.post(
            `https://${this.host}/api/v1/device/v2/iot/sts/arn`,
            {
                sn: serialNumber,
                verification_token: AnthbotCloudApiClient.buildVerificationToken(serialNumber),
            },
            {
                headers: {
                    ...this.authHeaders,
                    'content-type': 'application/json',
                },
            },
        );
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`IoT STS failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid IoT STS payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`IoT STS returned code=${JSON.stringify(payload.code)}`);
        }
        const data = payload.data;
        if (!data || typeof data !== 'object') {
            throw new AnthbotGenieError('IoT STS payload missing data object');
        }
        const requiredFields = ['access_key_id', 'secret_access_key', 'session_token', 'region_name', 'endpoint'];
        if (requiredFields.some(field => typeof data[field] !== 'string' || !data[field])) {
            throw new AnthbotGenieError('IoT STS payload missing required fields');
        }
        const expiration = asInteger(data.expiration);
        const expiresAt =
            expiration == null ? null : expiration > 2000000000 ? expiration * 1000 : Date.now() + expiration * 1000;
        return {
            accessKeyId: data.access_key_id,
            secretAccessKey: data.secret_access_key,
            sessionToken: data.session_token,
            regionName: data.region_name,
            endpoint: data.endpoint,
            expiresAt,
        };
    }

    /**
     * @param {string} serialNumber
     * @returns {Promise<object>}
     */
    async getDeviceAreaDefinition(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/presigned_url`, {
            headers: this.authHeaders,
            params: {
                filename: `area_${serialNumber}.txt`,
                sn: serialNumber,
                category: 'device',
                sub_category: 'area',
                verification_token: AnthbotCloudApiClient.buildVerificationToken(serialNumber),
            },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(
                `Area presigned URL failed (${response.status}): ${String(payload).slice(0, 300)}`,
            );
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid area presigned URL payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Area presigned URL returned code=${JSON.stringify(payload.code)}`);
        }
        const presignedUrl = payload?.data?.presigned_url;
        if (typeof presignedUrl !== 'string' || !presignedUrl) {
            throw new AnthbotGenieError('Area presigned URL payload missing presigned_url');
        }
        const areaResponse = await this.http.get(presignedUrl);
        if (areaResponse.status !== 200) {
            throw new AnthbotGenieError(
                `Area definition download failed (${areaResponse.status}): ${String(areaResponse.data).slice(0, 300)}`,
            );
        }
        const rawText = typeof areaResponse.data === 'string' ? areaResponse.data : JSON.stringify(areaResponse.data);
        let areaDefinition;
        try {
            areaDefinition = JSON.parse(rawText);
        } catch {
            throw new AnthbotGenieError('Area definition is not valid JSON');
        }
        if (!areaDefinition || typeof areaDefinition !== 'object' || Array.isArray(areaDefinition)) {
            throw new AnthbotGenieError('Area definition payload type is not an object');
        }
        return areaDefinition;
    }

    /**
     * Download the native map archive used by the Anthbot app. The map file
     * name comes from the property's multi_maps.map_list entry, for example
     * map_<serial>_0. Unlike area_<serial>.txt this archive contains the
     * raster under maps/remote_map_navi.map.
     *
     * @param {string} serialNumber
     * @param {string|null} [mapFileName]
     * @returns {Promise<Buffer>}
     */
    async getDeviceMapArchive(serialNumber, mapFileName = null) {
        this.requireToken();
        const filename = typeof mapFileName === 'string' && mapFileName ? mapFileName : `map_${serialNumber}_0`;
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/presigned_url`, {
            headers: this.authHeaders,
            params: {
                filename,
                sn: serialNumber,
                category: 'device',
                sub_category: 'multi_maps',
                verification_token: AnthbotCloudApiClient.buildVerificationToken(serialNumber),
            },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(
                `Map presigned URL failed (${response.status}): ${String(payload).slice(0, 300)}`,
            );
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid map presigned URL payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Map presigned URL returned code=${JSON.stringify(payload.code)}`);
        }
        const presignedUrl = payload?.data?.presigned_url;
        if (typeof presignedUrl !== 'string' || !presignedUrl) {
            throw new AnthbotGenieError('Map presigned URL payload missing presigned_url');
        }

        const mapResponse = await this.http.get(presignedUrl, { responseType: 'arraybuffer' });
        if (mapResponse.status !== 200) {
            throw new AnthbotGenieError(
                `Map archive download failed (${mapResponse.status}): ${String(mapResponse.data).slice(0, 300)}`,
            );
        }
        if (Buffer.isBuffer(mapResponse.data)) {
            return mapResponse.data;
        }
        if (mapResponse.data instanceof ArrayBuffer) {
            return Buffer.from(mapResponse.data);
        }
        if (ArrayBuffer.isView(mapResponse.data)) {
            return Buffer.from(mapResponse.data.buffer, mapResponse.data.byteOffset, mapResponse.data.byteLength);
        }
        throw new AnthbotGenieError('Map archive download returned an invalid binary payload');
    }

    /**
     * Download the historical mowing path requested from the mower.
     *
     * @param {string} serialNumber
     * @returns {Promise<Buffer>}
     */
    async getDeviceHistoryPath(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/presigned_url`, {
            headers: this.authHeaders,
            params: {
                filename: `path_${serialNumber}.txt`,
                sn: serialNumber,
                category: 'device',
                sub_category: 'path',
                verification_token: AnthbotCloudApiClient.buildVerificationToken(serialNumber),
            },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(
                `History path presigned URL failed (${response.status}): ${String(payload).slice(0, 300)}`,
            );
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid history path presigned URL payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`History path presigned URL returned code=${JSON.stringify(payload.code)}`);
        }
        const presignedUrl = payload?.data?.presigned_url;
        if (typeof presignedUrl !== 'string' || !presignedUrl) {
            throw new AnthbotGenieError('History path presigned URL payload missing presigned_url');
        }

        const pathResponse = await this.http.get(presignedUrl, { responseType: 'arraybuffer' });
        if (pathResponse.status !== 200) {
            throw new AnthbotGenieError(
                `History path download failed (${pathResponse.status}): ${String(pathResponse.data).slice(0, 300)}`,
            );
        }
        if (Buffer.isBuffer(pathResponse.data)) {
            return pathResponse.data;
        }
        if (pathResponse.data instanceof ArrayBuffer) {
            return Buffer.from(pathResponse.data);
        }
        if (ArrayBuffer.isView(pathResponse.data)) {
            return Buffer.from(pathResponse.data.buffer, pathResponse.data.byteOffset, pathResponse.data.byteLength);
        }
        if (typeof pathResponse.data === 'string') {
            return Buffer.from(pathResponse.data, 'utf8');
        }
        throw new AnthbotGenieError('History path download returned an invalid payload');
    }

    /**
     * @returns {Promise<number>}
     */
    async getEventCodeVersion() {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/message/code/version`, {
            headers: this.authHeaders,
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(
                `Event code version failed (${response.status}): ${String(payload).slice(0, 300)}`,
            );
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid event code version payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Event code version returned code=${JSON.stringify(payload.code)}`);
        }

        const data = payload.data;
        const version =
            typeof data === 'object' && data !== null
                ? asInteger(data.version ?? data.event_code_version ?? data.code_version)
                : asInteger(data);
        if (version == null) {
            throw new AnthbotGenieError('Event code version payload missing version');
        }
        return version;
    }

    /**
     * @param {number} version
     * @returns {Promise<object>}
     */
    async getEventCodeTranslations(version) {
        this.requireToken();
        const response = await this.http.post(
            `https://${this.host}/api/v1/message/code/translate`,
            { version },
            {
                headers: {
                    ...this.authHeaders,
                    'content-type': 'application/json',
                },
            },
        );
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(
                `Event code translations failed (${response.status}): ${String(payload).slice(0, 300)}`,
            );
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid event code translations payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Event code translations returned code=${JSON.stringify(payload.code)}`);
        }
        if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
            throw new AnthbotGenieError('Event code translations payload missing data object');
        }
        return payload;
    }

    /**
     * @param {string} serialNumber
     * @returns {Promise<string|null>}
     */
    async getDevicePresignedRegion(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/presigned_url`, {
            headers: this.authHeaders,
            params: { sn: serialNumber },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Presigned URL failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== 'object') {
            throw new AnthbotGenieError('Invalid presigned URL payload type');
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Presigned URL returned code=${JSON.stringify(payload.code)}`);
        }
        const presignedUrl = payload?.data?.presigned_url;
        if (typeof presignedUrl !== 'string' || !presignedUrl) {
            throw new AnthbotGenieError('Presigned URL payload missing presigned_url');
        }

        let parsed;
        try {
            parsed = new URL(presignedUrl);
        } catch {
            return null;
        }

        const hostParts = parsed.hostname.split('.');
        if (hostParts.length >= 4 && hostParts[0] === 's3') {
            const candidate = hostParts[1] === 'dualstack' ? hostParts[2] : hostParts[1];
            if (candidate && candidate !== 'amazonaws' && candidate !== 'amazonaws.com') {
                return candidate;
            }
        }

        const credential = parsed.searchParams.get('X-Amz-Credential');
        if (credential) {
            const credentialParts = credential.split('/');
            if (credentialParts.length >= 3 && credentialParts[2]) {
                return credentialParts[2];
            }
        }

        return null;
    }
}

module.exports = {
    AnthbotCloudApiClient,
};
