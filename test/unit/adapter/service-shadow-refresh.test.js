"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const moduleWithLoader = /** @type {any} */ (Module);

const originalModuleLoad = moduleWithLoader._load;
moduleWithLoader._load = function (request, parent, isMain) {
    if (request === "@iobroker/adapter-core") {
        return {
            Adapter: class Adapter {},
            I18n: { getTranslatedObject: value => value, init: async () => {} },
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const { AnthbotGenieAdapter } = require("../../../main");
moduleWithLoader._load = originalModuleLoad;

function createAdapter(config = {}) {
    const adapter = Object.create(AnthbotGenieAdapter.prototype);
    adapter.config = {
        fetchMap: false,
        generateMapWithPaths: false,
        errorDescriptionLanguage: "English",
        ...config,
    };
    adapter.log = {
        debug: message => adapter.logs.push(["debug", message]),
        error: message => adapter.logs.push(["error", message]),
        info: message => adapter.logs.push(["info", message]),
        warn: message => adapter.logs.push(["warn", message]),
    };
    adapter.logs = [];
    adapter.states = [];
    adapter.namespace = "anthbot-genie.0";
    adapter.eventCodeCache = null;
    adapter.deviceContextsByObjectRoot = new Map();
    adapter.setStateAsync = async (...args) => adapter.states.push(args);
    adapter.ensureDeviceIotCredentials = async () => {};
    adapter.updateStates = async (context, data) => {
        adapter.lastUpdate = { context, data };
    };
    adapter.delay = async () => {};
    return adapter;
}

/**
 * @param {{ propertyState?: object, serviceState?: object, serviceError?: Error }} [options]
 */
function createContext({ propertyState = { area_time: "1", battery: 80 }, serviceState, serviceError } = {}) {
    const calls = { property: 0, service: 0 };
    const shadowClient = {
        getShadowReportedState: async () => {
            calls.property += 1;
            return propertyState;
        },
        getServiceReportedState: async () => {
            calls.service += 1;
            if (serviceError) {
                throw serviceError;
            }
            return serviceState;
        },
    };
    return {
        calls,
        context: {
            device: { serialNumber: "SN123", alias: "Garden", model: "Anthbot Genie 600" },
            objectRoot: "SN123",
            shadowClient,
            iotCredentials: { accessKeyId: "key" },
            region: {},
            areaDefinition: { custom_areas: [] },
            lastReported: { old: "property" },
            lastService: { cmd: "old" },
            lastMapVersion: null,
            mapRaster: null,
            historyPath: null,
        },
    };
}

function createCachedMapContext() {
    const result = createContext({
        propertyState: {
            area_time: "1",
            map_tar_time: "1",
            map_time: "1",
            multi_maps: { map_list: [{ map_file_name: "map_SN123", md5: "hash" }] },
        },
    });
    result.context.lastMapVersion = "1|1|map_SN123|hash";
    result.context.mapRaster = {
        width: 4,
        height: 4,
        pixels: Buffer.alloc(16),
        metadata: {
            navi_map: {
                width: 4,
                height: 4,
                resolution: 0.5,
                x_min: -1,
                y_min: -1,
            },
        },
    };
    return result;
}

describe("service shadow refresh policy", () => {
    it("starts the initial refresh with an explicit service-shadow read", async () => {
        const adapter = createAdapter({ username: "user", password: "password" });
        const refreshes = [];
        adapter.ensureBaseObjects = async () => {};
        adapter.subscribeStates = () => {};
        adapter.refreshAll = async (...args) => refreshes.push(args);
        adapter.schedulePoll = () => {};

        await adapter.onReady();

        assert.deepEqual(refreshes, [[true, true]]);
    });

    it("reads only the property shadow during a regular refresh and keeps the service cache", async () => {
        const adapter = createAdapter();
        const { calls, context } = createContext({ serviceState: { cmd: "new" } });
        adapter.cloudClient = {};

        await adapter.refreshDevice(context);

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 0);
        assert.deepEqual(context.lastService, { cmd: "old" });
        assert.deepEqual(adapter.lastUpdate.data._service_reported, { cmd: "old" });
    });

    it("reads and updates the service shadow when explicitly requested", async () => {
        const adapter = createAdapter();
        const { calls, context } = createContext({ serviceState: { cmd: "find_robot" } });
        adapter.cloudClient = {};

        await adapter.refreshDevice(context, { readService: true });

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 1);
        assert.deepEqual(context.lastService, { cmd: "find_robot" });
        assert.deepEqual(adapter.lastUpdate.data._service_reported, { cmd: "find_robot" });
    });

    it("continues a property refresh and preserves the last service value after a service error", async () => {
        const adapter = createAdapter();
        const { calls, context } = createContext({
            serviceState: { cmd: "ignored" },
            serviceError: new Error("Shadow request failed (429): TOO_MANY_REQUESTS"),
        });
        adapter.cloudClient = {};

        await adapter.refreshDevice(context, { readService: true });

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 1);
        assert.deepEqual(context.lastService, { cmd: "old" });
        assert.deepEqual(adapter.lastUpdate.data._service_reported, { cmd: "old" });
        assert.match(
            adapter.logs.find(([, message]) => message.includes("Service shadow failed"))[1],
            /SN123.*429/,
        );
    });

    it("logs property shadow 429 errors without trying a second shadow read", async () => {
        const adapter = createAdapter();
        const { calls, context } = createContext();
        const propertyError = new Error("Shadow request failed (429): TOO_MANY_REQUESTS");
        context.shadowClient.getShadowReportedState = async () => {
            calls.property += 1;
            throw propertyError;
        };
        context.shadowClient.getServiceReportedState = async () => {
            calls.service += 1;
            return { cmd: "unexpected" };
        };
        adapter.cloudClient = {};

        await assert.rejects(adapter.refreshDevice(context), /429/);

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 0);
        assert.match(
            adapter.logs.find(([, message]) => message.includes("Property shadow failed"))[1],
            /SN123.*429/,
        );
    });

    it("keeps the service-read mode across an authentication retry", async () => {
        const adapter = createAdapter();
        const { context } = createContext({ serviceState: { cmd: "new" } });
        const modes = [];
        let sessionCalls = 0;
        adapter.deviceContexts = new Map([[context.device.serialNumber, context]]);
        adapter.ensureSession = async force => {
            sessionCalls += 1;
            if (!force) {
                throw new Error("401 session expired");
            }
        };
        adapter.discoverDevices = async () => {};
        adapter.ensureEventCodeCache = async () => {};
        adapter.refreshDevice = async (_context, options) => modes.push(options);

        await adapter.runRefreshCycle(false, false, true);

        assert.equal(sessionCalls, 2);
        assert.deepEqual(modes, [{ readService: true }]);
    });

    it("reads the service shadow after the internal history-path command", async () => {
        const adapter = createAdapter();
        const events = [];
        const { context } = createContext();
        context.shadowClient.publishServiceCommand = async payload => {
            events.push(["publish", payload]);
        };
        adapter.cloudClient = {
            getDeviceHistoryPath: async () => {
                events.push(["download"]);
                return Buffer.from("0,0\n10,20\n", "utf8");
            },
        };

        const points = await adapter.refreshHistoryPath(context, { path_time: "1" }, async () => {
            events.push(["service-read"]);
        });

        assert.deepEqual(points, [
            { x: 0, y: 0, flag: 5 },
            { x: 10, y: 20, flag: 5 },
        ]);
        assert.deepEqual(events, [
            ["publish", { cmd: "req_history_mapping_path", data: { start_pos: 0 } }],
            ["service-read"],
            ["download"],
        ]);
    });

    it("does not request map archives or history when path generation is disabled", async () => {
        const adapter = createAdapter({ fetchMap: true, generateMapWithPaths: false });
        const { calls, context } = createCachedMapContext();
        let mapArchiveCalls = 0;
        let historyCalls = 0;
        adapter.cloudClient = {
            getDeviceMapArchive: async () => {
                mapArchiveCalls += 1;
                throw new Error("map archive should be cached");
            },
            getDeviceHistoryPath: async () => {
                historyCalls += 1;
                throw new Error("history should be disabled");
            },
        };
        adapter.refreshHistoryPath = async () => {
            historyCalls += 1;
            return [];
        };

        await adapter.refreshDevice(context);

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 0);
        assert.equal(mapArchiveCalls, 0);
        assert.equal(historyCalls, 0);
    });

    it("uses one post-command service read when history generation runs during the initial refresh", async () => {
        const adapter = createAdapter({ fetchMap: true, generateMapWithPaths: true });
        const { calls, context } = createCachedMapContext();
        const events = [];
        context.shadowClient.publishServiceCommand = async payload => {
            events.push(["publish", payload]);
        };
        context.shadowClient.getServiceReportedState = async () => {
            calls.service += 1;
            events.push(["service-read"]);
            return { cmd: "history" };
        };
        adapter.cloudClient = {};
        adapter.refreshHistoryPath = async (_context, _propertyState, afterServiceCommand) => {
            await context.shadowClient.publishServiceCommand({
                cmd: "req_history_mapping_path",
                data: { start_pos: 0 },
            });
            await afterServiceCommand();
            return [];
        };

        await adapter.refreshDevice(context, { readService: true });

        assert.equal(calls.property, 1);
        assert.equal(calls.service, 1);
        assert.deepEqual(events, [
            ["publish", { cmd: "req_history_mapping_path", data: { start_pos: 0 } }],
            ["service-read"],
        ]);
    });

    it("refreshes after processed command, control, and consumable writes", async () => {
        const adapter = createAdapter();
        const context = { device: { serialNumber: "SN123" } };
        adapter.deviceContextsByObjectRoot.set("SN123", context);
        adapter.resetWriteState = async () => {};
        const refreshOptions = [];
        adapter.refreshDevice = async (_context, options) => refreshOptions.push(options);

        adapter.handleCommandState = async () => true;
        await adapter.onStateChange("anthbot-genie.0.SN123.commands.device.find", { val: true, ack: false });

        adapter.handleControlState = async () => true;
        await adapter.onStateChange("anthbot-genie.0.SN123.controls.voiceVolume", { val: 50, ack: false });

        adapter.handleConsumableState = async () => true;
        await adapter.onStateChange("anthbot-genie.0.SN123.consumable.blade.reset", { val: true, ack: false });

        adapter.handleCommandState = async () => false;
        await adapter.onStateChange("anthbot-genie.0.SN123.commands.device.find", { val: false, ack: false });
        await adapter.onStateChange("anthbot-genie.0.SN123.commands.device.find", { val: true, ack: true });

        assert.deepEqual(refreshOptions, [{ readService: true }, { readService: true }, { readService: true }]);
    });
});
