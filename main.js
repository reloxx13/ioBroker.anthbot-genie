'use strict';

/** @type {typeof import('@iobroker/adapter-core')} */
const utils = require('@iobroker/adapter-core');
const axios = /** @type {import('axios').AxiosStatic} */ (/** @type {unknown} */ (require('axios')));
const { AnthbotCloudApiClient } = require('./lib/anthbot/cloud-client');
const { AnthbotShadowApiClient } = require('./lib/anthbot/shadow-client');
const {
    AnthbotGenieError,
    asInteger,
    deviceObjectIdFromSerial,
    isLikelyAuthenticationError,
} = require('./lib/anthbot/utils');
const {
    BOOLEAN_COMMANDS,
    MAINTENANCE_RESET_TYPES,
    STRING_COMMANDS,
    getDeviceChannelDefinitions,
    getDeviceStateDefinitions,
} = require('./lib/adapter/definitions');
const {
    isMapFetchingEnabled,
    isMapPathGenerationEnabled,
    normalizePollIntervalSeconds,
} = require('./lib/adapter/config');
const { buildDeviceStateUpdates, getControlFallbackValue, mowerPoseInMeters } = require('./lib/adapter/state-updates');
const { executeCommand, executeConsumableCommand, executeControl } = require('./lib/adapter/actions');
const {
    extractMapRasterFromArchive,
    hasRobotIconAsset,
    parseHistoryPath,
    updateMapImageCache,
} = require('./lib/anthbot/map-renderer');

/**
 * @typedef {object} AnthbotAdapterConfig
 * @property {string} username
 * @property {string} password
 * @property {string} areaCode
 * @property {string} apiHost
 * @property {number} pollInterval
 * @property {boolean} fetchMap
 * @property {boolean} generateMapWithPaths
 * @property {string} errorDescriptionLanguage
 */

/** @typedef {ioBroker.Adapter} IoBrokerAdapter */
/** @typedef {new (options: ioBroker.AdapterOptions | string) => IoBrokerAdapter} AdapterCtor */

const AdapterBase = /** @type {AdapterCtor} */ (utils.Adapter);
const { I18n } = utils;
const HISTORY_PATH_READY_DELAY_MS = 5000;
const HISTORY_PATH_RETRY_DELAY_MS = 500;
const HISTORY_PATH_DOWNLOAD_ATTEMPTS = 3;

function t(en) {
    return I18n.getTranslatedObject(en);
}

class AnthbotGenieAdapter extends AdapterBase {
    constructor(options = {}) {
        super({
            ...options,
            name: 'anthbot-genie',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.http = null;
        this.cloudClient = null;
        this.authToken = null;
        this.deviceContexts = new Map();
        this.deviceContextsByObjectRoot = new Map();
        this.eventCodeCache = null;
        this.eventCodeCacheInitialized = false;
        this.pollTimer = null;
        this.refreshInFlight = null;
        this.unloaded = false;
    }

    /**
     * @returns {AnthbotAdapterConfig}
     */
    get anthbotConfig() {
        return /** @type {AnthbotAdapterConfig} */ (this.config);
    }

    async onReady() {
        this.unloaded = false;
        const config = this.anthbotConfig;
        this.http = axios.create({
            timeout: 15000,
            validateStatus: () => true,
        });

        await I18n.init(__dirname, this);
        await this.ensureBaseObjects();
        await this.setStateAsync('info.connection', false, true);

        if (!config.username || !config.password) {
            this.log.error('Username and password must be configured.');
            return;
        }

        this.subscribeStates('*.commands.*');
        this.subscribeStates('*.controls.*');
        this.subscribeStates('*.consumable.*.reset');

        await this.refreshAll(true, true);
        this.schedulePoll();
    }

    async ensureBaseObjects() {
        await this.extendObjectAsync('info', {
            type: 'channel',
            common: {
                name: t('Info'),
            },
            native: {},
        });

        await this.extendObjectAsync('info.connection', {
            type: 'state',
            common: {
                name: t('Cloud connection'),
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
    }

    onUnload(callback) {
        try {
            this.unloaded = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    schedulePoll() {
        if (this.unloaded) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        const intervalSeconds = normalizePollIntervalSeconds(this.anthbotConfig.pollInterval);
        this.pollTimer = this.setTimeout(async () => {
            this.pollTimer = null;
            try {
                await this.refreshAll(false, false);
            } finally {
                if (!this.unloaded) {
                    this.schedulePoll();
                }
            }
        }, intervalSeconds * 1000);
    }

    async refreshAll(forceLogin = false, readService = false) {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = this.doRefreshAll(forceLogin, readService).finally(() => {
            this.refreshInFlight = null;
        });
        return this.refreshInFlight;
    }

    async doRefreshAll(forceLogin = false, readService = false) {
        return this.runRefreshCycle(forceLogin, false, readService);
    }

    async runRefreshCycle(forceLogin, retriedAfterAuthFailure, readService) {
        let successful = 0;
        try {
            await this.ensureSession(forceLogin);
            await this.discoverDevices(forceLogin);
            await this.ensureEventCodeCache();
            for (const context of this.deviceContexts.values()) {
                try {
                    await this.refreshDevice(context, { readService });
                    successful += 1;
                } catch (error) {
                    this.log.warn(`Refresh failed for ${context.device.serialNumber}: ${error.message}`);
                }
            }
        } catch (error) {
            if (!retriedAfterAuthFailure && !forceLogin && isLikelyAuthenticationError(error)) {
                this.log.info('Anthbot cloud session expired, retrying refresh with a new login.');
                return this.runRefreshCycle(true, true, readService);
            }
            this.log.error(`Global refresh failed: ${error.message}`);
        }

        await this.setStateAsync('info.connection', successful > 0, true);
    }

    async ensureEventCodeCache() {
        if (this.eventCodeCacheInitialized) {
            return;
        }
        this.eventCodeCacheInitialized = true;

        const cached = await this.readStoredEventCodeCache();
        this.eventCodeCache = cached;

        let cloudVersion = null;
        try {
            cloudVersion = await this.cloudClient.getEventCodeVersion();
        } catch (error) {
            if (cached) {
                this.log.warn(`Failed to fetch event code version, using cached translations: ${error.message}`);
                await this.writeEventCodeCacheToDevices(cached);
            } else {
                this.log.warn(
                    `Failed to fetch event code version and no cached translations are available: ${error.message}`,
                );
            }
            return;
        }

        if (cached && asInteger(cached.version) === cloudVersion) {
            this.eventCodeCache = cached;
            await this.writeEventCodeCacheToDevices(cached);
            return;
        }

        try {
            const payload = await this.cloudClient.getEventCodeTranslations(cloudVersion);
            this.eventCodeCache = {
                version: cloudVersion,
                fetchedAt: new Date().toISOString(),
                payload,
            };
            await this.writeEventCodeCacheToDevices(this.eventCodeCache);
        } catch (error) {
            if (cached) {
                this.log.warn(`Failed to fetch event code translations, using cached translations: ${error.message}`);
                this.eventCodeCache = cached;
                await this.writeEventCodeCacheToDevices(cached);
            } else {
                this.log.warn(
                    `Failed to fetch event code translations and no cached translations are available: ${error.message}`,
                );
            }
        }
    }

    async readStoredEventCodeCache() {
        for (const context of this.deviceContexts.values()) {
            const root = context.objectRoot;
            try {
                const state = await this.getStateAsync(`${root}.raw.shadow.event-code`);
                const raw = typeof state?.val === 'string' ? state.val : '';
                if (!raw) {
                    continue;
                }
                const parsed = JSON.parse(raw);
                if (this.isValidEventCodeCache(parsed)) {
                    return parsed;
                }
            } catch (error) {
                this.log.debug(
                    `Stored event code cache could not be read for ${context.device.serialNumber}: ${error.message}`,
                );
            }
        }
        return null;
    }

    isValidEventCodeCache(cache) {
        return Boolean(
            cache &&
            typeof cache === 'object' &&
            asInteger(cache.version) != null &&
            cache.payload &&
            typeof cache.payload === 'object' &&
            !Array.isArray(cache.payload),
        );
    }

    async writeEventCodeCacheToDevices(cache) {
        if (!cache) {
            return;
        }
        const value = JSON.stringify(cache);
        for (const context of this.deviceContexts.values()) {
            await this.setStateAsync(`${context.objectRoot}.raw.shadow.event-code`, { val: value, ack: true });
        }
    }

    async ensureSession(force = false) {
        const config = this.anthbotConfig;
        if (!this.cloudClient || force) {
            this.cloudClient = new AnthbotCloudApiClient({
                http: this.http,
                host: config.apiHost || 'api.anthbot.com',
                bearerToken: force ? null : this.authToken,
            });
        }
        if (!this.authToken || force) {
            this.authToken = await this.cloudClient.login({
                username: config.username,
                password: config.password,
                areaCode: String(config.areaCode || '49'),
            });
        }
    }

    async discoverDevices(force = false) {
        if (this.deviceContexts.size > 0 && !force) {
            return;
        }

        const devices = await this.cloudClient.getBoundDevices();
        if (!devices.length) {
            throw new AnthbotGenieError('No Anthbot devices found for this account');
        }

        const seenSerials = new Set(devices.map(device => device.serialNumber));
        await this.removeStaleDeviceContexts(seenSerials);

        for (const device of devices) {
            const region = await this.resolveDeviceRegion(device);
            const existing = this.deviceContexts.get(device.serialNumber);
            const objectRoot = deviceObjectIdFromSerial(device.serialNumber, this.FORBIDDEN_CHARS);
            const context = {
                device,
                objectRoot,
                region,
                shadowClient: region.iotCredentials
                    ? this.buildShadowClient(device, region, region.iotCredentials)
                    : null,
                iotCredentials: region.iotCredentials,
                areaDefinition: existing?.areaDefinition || {},
                lastAreaTime: existing?.lastAreaTime || null,
                lastMapVersion: existing?.lastMapVersion || null,
                mapRaster: existing?.mapRaster || null,
                mapImageCache: existing?.mapImageCache || null,
                historyPath: existing?.historyPath || null,
                lastHistoryPathKey: existing?.lastHistoryPathKey || null,
                lastHistoryPathRequestKey: existing?.lastHistoryPathRequestKey || null,
                lastHistoryPathRequestAt: existing?.lastHistoryPathRequestAt || 0,
                lastRobotIconFallbackModel: existing?.lastRobotIconFallbackModel || null,
                lastReported: existing?.lastReported || {},
                lastService: existing?.lastService || {},
            };
            this.deviceContexts.set(device.serialNumber, context);
            this.deviceContextsByObjectRoot.set(objectRoot, context);
            await this.ensureDeviceObjects(context);
        }
    }

    async resolveDeviceRegion(device) {
        let regionName = null;
        let iotEndpoint = null;
        let iotCredentials = null;

        try {
            const deviceRegion = await this.cloudClient.getDeviceRegion(device.serialNumber);
            regionName = deviceRegion.regionName;
            iotEndpoint = deviceRegion.iotEndpoint;
        } catch (error) {
            this.log.warn(
                `Failed to fetch region metadata for ${device.serialNumber}, using fallback discovery: ${error.message}`,
            );
        }

        try {
            const fallbackRegion = await this.cloudClient.getDevicePresignedRegion(device.serialNumber);
            if (fallbackRegion) {
                if (!regionName) {
                    regionName = fallbackRegion;
                }
                if (!iotEndpoint && !fallbackRegion.startsWith('cn')) {
                    iotEndpoint = AnthbotShadowApiClient.buildDefaultIotEndpointForRegion(fallbackRegion);
                } else if (iotEndpoint && !fallbackRegion.startsWith('cn')) {
                    const endpointRegion = AnthbotShadowApiClient.guessRegionFromEndpoint(iotEndpoint);
                    if (endpointRegion && endpointRegion !== fallbackRegion) {
                        regionName = fallbackRegion;
                        iotEndpoint = AnthbotShadowApiClient.buildDefaultIotEndpointForRegion(fallbackRegion);
                        this.log.debug(
                            `Overriding mismatched region metadata for ${device.serialNumber}: region=${regionName}, endpoint=${iotEndpoint}`,
                        );
                    }
                }
            }
        } catch (error) {
            this.log.debug(`Presigned region fallback failed for ${device.serialNumber}: ${error.message}`);
        }

        try {
            iotCredentials = await this.cloudClient.getDeviceIotCredentials(device.serialNumber);
            regionName = iotCredentials.regionName || regionName;
            iotEndpoint = iotCredentials.endpoint || iotEndpoint;
        } catch (error) {
            this.log.warn(
                `Failed to fetch temporary IoT credentials for ${device.serialNumber}; shadow access is unavailable until STS succeeds again: ${error.message}`,
            );
        }

        return {
            serialNumber: device.serialNumber,
            regionName: regionName || AnthbotShadowApiClient.guessRegionFromEndpoint(iotEndpoint) || 'unknown',
            iotEndpoint,
            iotCredentials,
        };
    }

    async removeStaleDeviceContexts(seenSerials) {
        for (const serial of this.deviceContexts.keys()) {
            if (seenSerials.has(serial)) {
                continue;
            }
            const context = this.deviceContexts.get(serial);
            this.deviceContexts.delete(serial);
            if (context?.objectRoot) {
                this.deviceContextsByObjectRoot.delete(context.objectRoot);
            }
            try {
                await this.delObjectAsync(
                    context?.objectRoot || deviceObjectIdFromSerial(serial, this.FORBIDDEN_CHARS),
                    { recursive: true },
                );
                this.log.info(`Removed stale device objects for ${serial}.`);
            } catch (error) {
                this.log.warn(`Failed to remove stale device objects for ${serial}: ${error.message}`);
            }
        }
    }

    async ensureDeviceObjects(context) {
        const serial = context.device.serialNumber;
        const root = context.objectRoot;

        await this.extendObjectAsync(root, {
            type: 'device',
            common: {
                name: context.device.alias,
            },
            native: {
                serialNumber: serial,
            },
        });

        for (const [id, type, name] of getDeviceChannelDefinitions(t)) {
            await this.extendObjectAsync(`${root}.${id}`, {
                type,
                common: { name },
                native: {},
            });
        }

        for (const [suffix, common] of Object.entries(getDeviceStateDefinitions(t))) {
            await this.extendObjectAsync(`${root}.${suffix}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    async refreshDevice(context, { readService = false } = {}) {
        await this.ensureDeviceIotCredentials(context);
        if (!context.shadowClient) {
            throw new AnthbotGenieError(
                `Skipping ${context.device.serialNumber}: temporary IoT credentials are unavailable for shadow access`,
            );
        }
        let propertyState;
        try {
            propertyState = await context.shadowClient.getShadowReportedState();
        } catch (error) {
            this.log.debug(`Property shadow failed for ${context.device.serialNumber}: ${error.message}`);
            throw error;
        }

        let serviceReadAttempted = false;
        let serviceState = context.lastService || {};
        const readServiceShadow = async () => {
            if (serviceReadAttempted) {
                return serviceState;
            }
            serviceReadAttempted = true;
            try {
                const reported = await context.shadowClient.getServiceReportedState();
                if (reported && typeof reported === 'object' && !Array.isArray(reported)) {
                    context.lastService = reported;
                    serviceState = reported;
                }
            } catch (error) {
                this.log.debug(`Service shadow failed for ${context.device.serialNumber}: ${error.message}`);
                serviceState = context.lastService || {};
            }
            return serviceState;
        };

        const areaTime = this.mapVersion(propertyState.area_time);
        const shouldRefreshArea =
            !context.areaDefinition ||
            Object.keys(context.areaDefinition).length === 0 ||
            (areaTime && areaTime !== context.lastAreaTime);
        if (shouldRefreshArea) {
            try {
                context.areaDefinition = await this.cloudClient.getDeviceAreaDefinition(context.device.serialNumber);
                context.lastAreaTime = areaTime;
            } catch (error) {
                if (isLikelyAuthenticationError(error)) {
                    await this.ensureSession(true);
                    context.areaDefinition = await this.cloudClient.getDeviceAreaDefinition(
                        context.device.serialNumber,
                    );
                    context.lastAreaTime = areaTime;
                } else {
                    this.log.debug(
                        `Area definition refresh failed for ${context.device.serialNumber}: ${error.message}`,
                    );
                }
            }
        }

        if (!isMapFetchingEnabled(this.anthbotConfig.fetchMap)) {
            this.clearMapContext(context);
            if (readService) {
                await readServiceShadow();
            }
            context.lastReported = propertyState;
            await this.updateStates(context, {
                ...propertyState,
                _service_reported: serviceState,
                _area_definition: context.areaDefinition || {},
            });
            return;
        }

        const mapFile = this.mapFileInfo(propertyState);
        const mapVersion =
            [
                this.mapVersion(propertyState.map_tar_time),
                this.mapVersion(propertyState.map_time),
                mapFile.mapFileName,
                mapFile.md5,
            ]
                .filter(Boolean)
                .join('|') || null;

        const shouldRefreshMap = !context.mapRaster || mapVersion !== context.lastMapVersion;
        if (shouldRefreshMap) {
            try {
                const mapArchive = await this.cloudClient.getDeviceMapArchive(
                    context.device.serialNumber,
                    mapFile.mapFileName,
                );
                const mapRaster = extractMapRasterFromArchive(mapArchive);
                if (!mapRaster) {
                    throw new AnthbotGenieError('Native map archive did not contain a valid navigation raster');
                }
                context.mapRaster = mapRaster;
                context.lastMapVersion = mapVersion;
            } catch (error) {
                if (isLikelyAuthenticationError(error)) {
                    await this.ensureSession(true);
                    const mapArchive = await this.cloudClient.getDeviceMapArchive(
                        context.device.serialNumber,
                        mapFile.mapFileName,
                    );
                    const mapRaster = extractMapRasterFromArchive(mapArchive);
                    if (!mapRaster) {
                        throw new AnthbotGenieError('Native map archive did not contain a valid navigation raster');
                    }
                    context.mapRaster = mapRaster;
                    context.lastMapVersion = mapVersion;
                } else {
                    this.log.debug(`Map refresh failed for ${context.device.serialNumber}: ${error.message}`);
                }
            }
        }

        const generateMapWithPaths = isMapPathGenerationEnabled(this.anthbotConfig.generateMapWithPaths);
        this.logMissingRobotIcon(context, generateMapWithPaths);
        const historyPath = generateMapWithPaths
            ? await this.refreshHistoryPath(context, propertyState, readServiceShadow)
            : [];

        if (readService && !serviceReadAttempted) {
            await readServiceShadow();
        }

        context.lastReported = propertyState;

        const merged = {
            ...propertyState,
            _service_reported: serviceState,
            _area_definition: context.areaDefinition || {},
        };
        updateMapImageCache(context, {
            mapVersion,
            mowedPath: historyPath,
            includeMowedPath: generateMapWithPaths,
            mowerPose: mowerPoseInMeters(propertyState),
            deviceModel: context.device.model,
            forbidAreas: [
                ...(Array.isArray(context.areaDefinition?.forbid_areas) ? context.areaDefinition.forbid_areas : []),
                ...(Array.isArray(context.areaDefinition?.remote_forbid_areas)
                    ? context.areaDefinition.remote_forbid_areas
                    : []),
            ],
        });
        await this.updateStates(context, merged);
    }

    /**
     * @param {object} context
     * @param {boolean} generateMapWithPaths
     */
    logMissingRobotIcon(context, generateMapWithPaths) {
        if (!generateMapWithPaths) {
            context.lastRobotIconFallbackModel = null;
            return;
        }

        const model =
            typeof context.device?.model === 'string' && context.device.model ? context.device.model : 'unknown';
        if (hasRobotIconAsset(context.device?.model)) {
            context.lastRobotIconFallbackModel = null;
            return;
        }
        if (context.lastRobotIconFallbackModel === model) {
            return;
        }

        this.log.debug(`No map robot icon found for model ${model}; using generated fallback icon`);
        context.lastRobotIconFallbackModel = model;
    }

    clearMapContext(context) {
        context.lastMapVersion = null;
        context.mapRaster = null;
        context.mapImageCache = null;
        context.historyPath = null;
        context.lastHistoryPathKey = null;
        context.lastHistoryPathRequestKey = null;
        context.lastHistoryPathRequestAt = 0;
    }

    /**
     * @param {object} propertyState
     * @returns {string}
     */
    historyPathKey(propertyState) {
        const historyInfo = propertyState?.history_path_info;
        const info =
            historyInfo?.value && typeof historyInfo.value === 'object' && !Array.isArray(historyInfo.value)
                ? historyInfo.value
                : historyInfo;
        const metadata = [info?.map_id, info?.path_id, info?.time].map(value => this.mapVersion(value));
        if (metadata.some(Boolean)) {
            return metadata.map(value => value || '').join('|');
        }
        return this.mapVersion(propertyState?.path_time) || 'current';
    }

    /**
     * Request and download the full historical mowing path. The live curpath
     * is intentionally not used here; an unavailable history leaves this
     * image without a path instead of showing a misleading short segment.
     *
     * @param {object} context
     * @param {object} propertyState
     * @param {(() => Promise<unknown>)|undefined} [afterServiceCommand]
     * @returns {Promise<{ x: number, y: number, flag: number }[]>}
     */
    async refreshHistoryPath(context, propertyState, afterServiceCommand) {
        const pathKey = this.historyPathKey(propertyState);
        if (Array.isArray(context.historyPath) && context.lastHistoryPathKey === pathKey) {
            return context.historyPath;
        }

        const now = Date.now();
        if (
            context.lastHistoryPathRequestKey === pathKey &&
            now - Number(context.lastHistoryPathRequestAt || 0) < 30000
        ) {
            return Array.isArray(context.historyPath) ? context.historyPath : [];
        }

        context.lastHistoryPathRequestKey = pathKey;
        context.lastHistoryPathRequestAt = now;
        try {
            await context.shadowClient.publishServiceCommand({
                cmd: 'req_history_mapping_path',
                data: { start_pos: 0 },
            });
            await this.delay(HISTORY_PATH_READY_DELAY_MS);
            if (afterServiceCommand) {
                await afterServiceCommand();
            }

            for (let attempt = 0; attempt < HISTORY_PATH_DOWNLOAD_ATTEMPTS; attempt++) {
                const pathFile = await this.cloudClient.getDeviceHistoryPath(context.device.serialNumber);
                const points = parseHistoryPath(pathFile);
                if (points.length) {
                    context.historyPath = points;
                    context.lastHistoryPathKey = pathKey;
                    return points;
                }
                if (attempt < HISTORY_PATH_DOWNLOAD_ATTEMPTS - 1) {
                    await this.delay(HISTORY_PATH_RETRY_DELAY_MS);
                }
            }
            throw new AnthbotGenieError('Historical path file did not contain usable coordinates');
        } catch (error) {
            context.lastHistoryPathRequestKey = null;
            context.lastHistoryPathRequestAt = 0;
            this.log.debug(`Historical path refresh failed for ${context.device.serialNumber}: ${error.message}`);
            return Array.isArray(context.historyPath) ? context.historyPath : [];
        }
    }

    /**
     * @param {object} propertyState
     * @returns {{ mapFileName: string|null, md5: string|null }}
     */
    mapFileInfo(propertyState) {
        const mapList = propertyState?.multi_maps?.map_list;
        if (!Array.isArray(mapList)) {
            return { mapFileName: null, md5: null };
        }
        const activeMapIds = [propertyState?.map_tar_time, propertyState?.map_time]
            .map(value => this.mapVersion(value))
            .filter(Boolean);
        const entries = mapList.filter(item => item && typeof item.map_file_name === 'string' && item.map_file_name);
        const entry = entries.find(item => activeMapIds.includes(this.mapVersion(item.map_id))) || entries[0];
        return {
            mapFileName: entry?.map_file_name || null,
            md5: typeof entry?.md5 === 'string' && entry.md5 ? entry.md5 : null,
        };
    }

    /**
     * @param {unknown} value
     * @returns {string|null}
     */
    mapVersion(value) {
        return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
    }

    async ensureDeviceIotCredentials(context) {
        if (
            context.shadowClient &&
            context.iotCredentials &&
            (!context.iotCredentials.expiresAt || context.iotCredentials.expiresAt - Date.now() > 60000)
        ) {
            return;
        }
        try {
            const iotCredentials = await this.cloudClient.getDeviceIotCredentials(context.device.serialNumber);
            context.iotCredentials = iotCredentials;
            context.region = {
                ...context.region,
                regionName: iotCredentials.regionName || context.region.regionName,
                iotEndpoint: iotCredentials.endpoint || context.region.iotEndpoint,
                iotCredentials,
            };
            context.shadowClient = this.buildShadowClient(context.device, context.region, iotCredentials);
        } catch (error) {
            context.iotCredentials = null;
            context.shadowClient = null;
            throw new AnthbotGenieError(
                `Temporary IoT credentials are unavailable for ${context.device.serialNumber}; shadow access is disabled until the STS endpoint recovers: ${error.message}`,
            );
        }
    }

    buildShadowClient(device, region, iotCredentials) {
        return new AnthbotShadowApiClient({
            http: this.http,
            serialNumber: device.serialNumber,
            regionName: region.regionName,
            iotEndpoint: region.iotEndpoint,
            accountClient: this.cloudClient,
            iotCredentials,
            deviceModel: device.model,
        });
    }

    async updateStates(context, data) {
        const root = context.objectRoot;
        const updates = buildDeviceStateUpdates({
            context,
            data,
            eventCodeCache: this.eventCodeCache,
            errorDescriptionLanguage: this.anthbotConfig.errorDescriptionLanguage || 'English',
            now: new Date(),
            includeMapImages: isMapFetchingEnabled(this.anthbotConfig.fetchMap),
            includeMowedPathImage: isMapPathGenerationEnabled(this.anthbotConfig.generateMapWithPaths),
        });

        for (const [suffix, value] of Object.entries(updates)) {
            await this.setStateAsync(`${root}.${suffix}`, { val: value, ack: true });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }

        const parts = id.replace(`${this.namespace}.`, '').split('.');
        if (parts.length < 3) {
            return;
        }

        const [objectRoot, section, ...commandParts] = parts;
        const command = commandParts.join('.');
        const context = this.deviceContextsByObjectRoot.get(objectRoot);
        if (!context) {
            this.log.warn(`No device context for state ${id}`);
            return;
        }

        let commandError = null;
        let commandProcessed = false;
        try {
            if (section === 'commands') {
                commandProcessed = await this.handleCommandState(context, command, state.val);
            } else if (section === 'controls') {
                commandProcessed = await this.handleControlState(context, command, state.val);
            } else if (section === 'consumable') {
                commandProcessed = await this.handleConsumableState(context, command, state.val);
            }
        } catch (error) {
            commandError = error;
        } finally {
            if (commandProcessed) {
                try {
                    await this.refreshDevice(context, { readService: true });
                } catch (refreshError) {
                    this.log.warn(`Post-command refresh failed for ${id}: ${refreshError.message}`);
                }
            }
            await this.resetWriteState(id, section, command, context);
        }

        if (commandError) {
            this.log.error(`Command failed for ${id}: ${commandError.message}`);
        }
    }

    async resetWriteState(id, section, command, context) {
        if (
            (section === 'commands' && BOOLEAN_COMMANDS.includes(command)) ||
            (section === 'consumable' && Object.hasOwn(MAINTENANCE_RESET_TYPES, command))
        ) {
            await this.setStateAsync(id, { val: false, ack: true });
            return;
        }
        if (section === 'commands' && STRING_COMMANDS.includes(command)) {
            await this.setStateAsync(id, { val: '', ack: true });
            return;
        }
        if (section === 'controls') {
            const fallbackValue = this.getControlFallbackValue(context, command);
            if (fallbackValue !== undefined) {
                await this.setStateAsync(id, { val: fallbackValue, ack: true });
            }
        }
    }

    getControlFallbackValue(context, control) {
        return getControlFallbackValue(context.lastReported || {}, control);
    }

    async handleCommandState(context, command, value) {
        const shouldRun =
            value === true || value === 1 || value === 'true' || (typeof value === 'string' && value.trim() !== '');
        if (!shouldRun) {
            return false;
        }

        await this.ensureDeviceIotCredentials(context);
        const shouldRequestProperties = await this.executeCommand(context, command, value);
        if (shouldRequestProperties) {
            await context.shadowClient.requestAllProperties();
        }
        await this.delay(1000);
        return true;
    }

    async handleControlState(context, control, value) {
        if (value === null || value === undefined || value === '') {
            return false;
        }

        await this.ensureDeviceIotCredentials(context);
        await this.executeControl(context, control, value);
        await context.shadowClient.requestAllProperties();
        await this.delay(1000);
        return true;
    }

    async handleConsumableState(context, command, value) {
        const shouldRun = value === true || value === 1 || value === 'true';
        if (!shouldRun) {
            return false;
        }

        await this.ensureDeviceIotCredentials(context);
        await this.executeConsumableCommand(context, command);
        await this.delay(1000);
        return true;
    }

    async executeCommand(context, command, value) {
        return executeCommand({ context, command, value });
    }

    async executeConsumableCommand(context, command) {
        await executeConsumableCommand({ context, command });
    }

    async executeControl(context, control, value) {
        await executeControl({ context, control, value });
    }

    delay(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }
}

if (require.main !== module) {
    module.exports = options => new AnthbotGenieAdapter(options);
    module.exports.AnthbotGenieAdapter = AnthbotGenieAdapter;
} else {
    new AnthbotGenieAdapter();
}
