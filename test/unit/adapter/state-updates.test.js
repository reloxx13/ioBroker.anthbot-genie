"use strict";

const assert = require("node:assert/strict");

const {
    buildDeviceStateUpdates,
    chargerPointInMeters,
    getControlFallbackValue,
    mowerPoseInMeters,
} = require("../../../lib/adapter/state-updates");

describe("lib/adapter/state-updates", () => {
    it("builds the expected Genie state update set", () => {
        const now = new Date("2026-06-08T12:00:00.000Z");
        const context = {
            device: {
                alias: "Front Yard",
                model: "Anthbot Genie 600",
            },
            region: {
                regionName: "eu-central-1",
            },
            shadowClient: {
                iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            },
            lastReported: {
                online: 1,
            },
            lastService: {
                cmd: "find_robot",
            },
            areaDefinition: {
                custom_areas: [{ id: 1, name: "Front", cutter_height: 35 }],
                region_areas: [{ id: 7, name: "Back", x: 12, y: 34 }],
            },
            mapRaster: {
                metadata: {
                    charger_point: { x: -728, y: 388, phi: 2, type: 83 },
                },
            },
        };
        const data = {
            ...context.lastReported,
            robot_sta: { value: 6 },
            elec: 78,
            err_code: 2012,
            mow_full: 1,
            mow_border: { value: 1 },
            mow_nest: { value: 0 },
            mow_point: { sta: 1, x: 10, y: 20 },
            mowing_time_new: { value: 3600 },
            mowing_area_new: { value: 123 },
            map_area: 456,
            map_sta: { value: "ready" },
            active_area: { id: [1, 3] },
            anti_loss_pose: {
                posegps: { lat: 51.1, lon: 9.2 },
                pose_type: "rtk",
            },
            pose: { x: 940, y: 3560, yaw: 90 },
            rtk_state: 3,
            ctl_rtk_base: { rtk_base_state: 3 },
            rtk_move_sta: { value: 1 },
            fw_version: {
                rtk_base: "1.0.0",
                system_version: "2.0.0",
                main_board: "mb-1",
                exten_board: "ex-1",
            },
            camera_error_sta: { value: 0 },
            wifi_state: 1,
            "4g_state": 0,
            heart_4g: 1,
            bt_state: 1,
            sta_ssid: "GardenWiFi",
            sta_ip_addr: "192.168.1.88",
            "4g_ccid": "8949",
            sim_status: { status: 1 },
            has_map: { value: 1 },
            acc_sta: { value: 0 },
            anti_loss_switch: 1,
            edge_switch: 1,
            indoor_switch: 0,
            auto_upgrade: 1,
            pobctl: { switch: 1, level: 2 },
            drc_switch: 1,
            log_switch: 0,
            factory_reset: 0,
            user_unbind: 1,
            pin_code: "1234",
            anti_loss_radius: 10,
            event_code: 99,
            protocol_version: "p1",
            min_app_version: "1.2.3",
            voice_status: { name: "en" },
            ota_status: { ota_progress: 50, ota_state: "downloading", ota_time_estimate: 600 },
            timestamp: 1711974896,
            system_boot_time: "20260428153045",
            map_time: "20260428153045",
            path_time: "20260428153045",
            area_time: "20260428153045",
            appointment_time: "20260428153045",
            param_set: {
                cutter_height: 35,
                rid_switch: 1,
                mow_head: 45,
                enable_adaptive_head: 0,
                mow_count: 2,
                nest_switch: 1,
            },
            volume: 67,
            rain_switch: 1,
            rain_continue_time: 7200,
            nest_switch: 1,
            nest_cutter_height: 40,
            nest_mow_count: 2,
            nest_pobctl_switch: 1,
            nest_pobctl_level: 2,
            robot_maintenance: {
                ccp_pecent: 98,
                cl_pecent: 97,
                rc_pecent: 96,
            },
            _service_reported: { cmd: "mow_start" },
            _area_definition: context.areaDefinition,
        };
        const eventCodeCache = {
            payload: {
                data: {
                    "2012": {
                        English: { event_message: "The machine is stuck" },
                    },
                },
            },
        };

        const updates = buildDeviceStateUpdates({
            context,
            data,
            eventCodeCache,
            errorDescriptionLanguage: "English",
            now,
        });

        assert.equal(updates["info.alias"], "Front Yard");
        assert.equal(updates["info.model"], "Anthbot Genie 600");
        assert.equal(updates["info.online"], true);
        assert.equal(updates["info.lastPoll"], now.toISOString());
        assert.equal(updates["metrics.status.mower"], "mowing");
        assert.equal(updates["metrics.error.description"], "The machine is stuck");
        assert.equal(updates["location.pose.x"], 0.94);
        assert.equal(updates["location.pose.y"], 3.56);
        assert.equal(updates["location.pose.yaw"], 90);
        assert.equal(updates["location.charger.x"], -0.728);
        assert.equal(updates["location.charger.y"], 0.388);
        assert.equal(updates["metrics.zones.manualCount"], 1);
        assert.equal(updates["metrics.zones.autoCount"], 1);
        assert.equal(updates["controls.fullMapMowing.mowHeight"], 35);
        assert.equal(updates["controls.fullMapMowing.customMowingDirectionEnabled"], true);
        assert.equal(updates["controls.rain.continueTimeHours"], 2);
        assert.equal(updates["controls.nearChargerMowing.mowHeight"], 40);
        assert.equal(updates["diagnostics.network.simPresent"], true);
        assert.equal(updates["diagnostics.time.systemBoot"], "2026-04-28T15:30:45.000Z");
        assert.equal(updates["zones.manual.activeIds"], "[1,3]");
        assert.equal(updates["zones.autoList"], '[{"id":7,"name":"Back","x":12,"y":34}]');
        assert.deepEqual(mowerPoseInMeters(data), { x: 0.94, y: 3.56, yaw: 90 });
        assert.equal(mowerPoseInMeters({}), null);
    });

    it("builds the expected M-series state update set", () => {
        const now = new Date("2026-06-08T12:00:00.000Z");
        const context = {
            device: {
                alias: "Back Yard",
                model: "Anthbot M5",
            },
            region: {
                regionName: "us-east-1",
            },
            shadowClient: {
                iotEndpoint: "a.example.iot.us-east-1.amazonaws.com",
            },
            lastReported: {},
            lastService: { cmd: "find_robot" },
            areaDefinition: {
                custom_areas: [{ id: 11, name: "Front" }],
                region_areas: [{ id: 22, name: "North", x: 100, y: 200 }],
            },
        };
        const data = {
            mode: { value: "charge" },
            elec: { value: 81 },
            error: { value: 0 },
            net_config: {
                ip: "192.168.1.77",
                ssid: "GardenWiFi",
                "4g_ccid": "8949000000000000000",
            },
            rtk: { state: "fixed" },
            map: { map_area: 321.5 },
            mapping_task: { state: "running" },
            mowing_time: { value: 7200 },
            mowing_area: { value: 456.7 },
            online: true,
            _service_reported: { cmd: "find_robot" },
            _area_definition: context.areaDefinition,
        };

        const updates = buildDeviceStateUpdates({
            context,
            data,
            eventCodeCache: null,
            errorDescriptionLanguage: "English",
            now,
        });

        assert.equal(updates["metrics.status.modeRaw"], "charge");
        assert.equal(updates["metrics.status.robotRaw"], "charge");
        assert.equal(updates["metrics.status.mower"], "charging");
        assert.equal(updates["metrics.batteryLevel"], 81);
        assert.equal(updates["metrics.map.totalArea"], 321.5);
        assert.equal(updates["metrics.map.mappingTaskState"], "running");
        assert.equal(updates["metrics.mowing.totalTime"], 7200);
        assert.equal(updates["metrics.mowing.totalArea"], 456.7);
        assert.equal(updates["diagnostics.rtk.state"], "fixed");
        assert.equal(updates["diagnostics.network.wifiSsid"], "GardenWiFi");
        assert.equal(updates["diagnostics.network.ipAddress"], "192.168.1.77");
        assert.equal(updates["diagnostics.network.simPresent"], true);
    });

    it("returns the same control fallback values used for write-state resets", () => {
        const data = {
            param_set: {
                cutter_height: 40,
                mow_head: 90,
                rid_switch: 1,
                enable_adaptive_head: 0,
                mow_count: 2,
                nest_switch: 1,
            },
            mow_remote: { cutter_height: 45 },
            volume: 33,
            pobctl: { switch: 1, level: 2 },
            rain_switch: 1,
            rain_continue_time: 7200,
            nest_cutter_height: 35,
            nest_mow_count: 2,
            nest_pobctl_switch: 1,
            nest_pobctl_level: 2,
        };

        assert.equal(getControlFallbackValue(data, "fullMapMowing.mowHeight"), 40);
        assert.equal(getControlFallbackValue(data, "voiceVolume"), 33);
        assert.equal(getControlFallbackValue(data, "fullMapMowing.customMowingDirection"), 90);
        assert.equal(getControlFallbackValue(data, "fullMapMowing.includeEdgeTrimming"), true);
        assert.equal(getControlFallbackValue(data, "fullMapMowing.customMowingDirectionEnabled"), true);
        assert.equal(getControlFallbackValue(data, "zoneMowing.mowCount"), 2);
        assert.equal(getControlFallbackValue(data, "zoneMowing.obstacleAvoidanceEnabled"), true);
        assert.equal(getControlFallbackValue(data, "zoneMowing.obstacleAvoidanceLevel"), 2);
        assert.equal(getControlFallbackValue(data, "rain.perceptionEnabled"), true);
        assert.equal(getControlFallbackValue(data, "rain.continueTimeHours"), 2);
        assert.equal(getControlFallbackValue(data, "nearChargerMowing.enabled"), true);
        assert.equal(getControlFallbackValue(data, "nearChargerMowing.mowHeight"), 35);
        assert.equal(getControlFallbackValue(data, "nearChargerMowing.mowCount"), 2);
        assert.equal(getControlFallbackValue(data, "nearChargerMowing.obstacleAvoidanceEnabled"), true);
        assert.equal(getControlFallbackValue(data, "nearChargerMowing.obstacleAvoidanceLevel"), 2);
        assert.equal(getControlFallbackValue(data, "not-supported"), undefined);
    });

    it("publishes cached map images as acknowledged read-only state values", () => {
        const stateUpdateArgs = {
            context: {
                device: { alias: "Garden", model: "Anthbot Genie 600" },
                region: { regionName: "eu-central-1" },
                shadowClient: { iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com" },
                lastReported: {},
                lastService: {},
                areaDefinition: {},
                mapImageCache: {
                    image: "data:image/png;base64,full",
                    imageWithRtkMask: "data:image/png;base64,mask",
                    imageWithMowedPath: "data:image/png;base64,path",
                },
            },
            data: { _area_definition: {} },
            eventCodeCache: null,
            errorDescriptionLanguage: "English",
            now: new Date("2026-07-16T12:00:00.000Z"),
        };
        const updates = buildDeviceStateUpdates(stateUpdateArgs);

        assert.equal(updates["map.image"], "data:image/png;base64,full");
        assert.equal(updates["map.imageWithRtkMask"], "data:image/png;base64,mask");
        assert.equal(updates["map.imageWithMowedPath"], "data:image/png;base64,path");
        assert.equal(updates["location.charger.x"], null);
        assert.equal(updates["location.charger.y"], null);

        const withoutMap = buildDeviceStateUpdates({ ...stateUpdateArgs, includeMapImages: false });
        assert.equal(Object.hasOwn(withoutMap, "map.image"), false);
        assert.equal(Object.hasOwn(withoutMap, "map.imageWithRtkMask"), false);
        assert.equal(Object.hasOwn(withoutMap, "map.imageWithMowedPath"), false);

        const withoutPath = buildDeviceStateUpdates({ ...stateUpdateArgs, includeMowedPathImage: false });
        assert.equal(withoutPath["map.image"], "data:image/png;base64,full");
        assert.equal(withoutPath["map.imageWithRtkMask"], "data:image/png;base64,mask");
        assert.equal(Object.hasOwn(withoutPath, "map.imageWithMowedPath"), false);
    });

    it("publishes charger coordinates from cached metadata without a rendered map", () => {
        const context = {
            device: { alias: "Garden", model: "Anthbot Genie 600" },
            region: { regionName: "eu-central-1" },
            shadowClient: { iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com" },
            lastReported: {},
            lastService: {},
            areaDefinition: {},
            mapMetadata: {
                charger_point: { x: -728, y: 388 },
            },
        };
        const updates = buildDeviceStateUpdates({
            context,
            data: {},
            eventCodeCache: null,
            errorDescriptionLanguage: "English",
            now: new Date("2026-07-16T12:00:00.000Z"),
            includeMapImages: false,
        });

        assert.deepEqual(chargerPointInMeters(context), { x: -0.728, y: 0.388 });
        assert.equal(updates["location.charger.x"], -0.728);
        assert.equal(updates["location.charger.y"], 0.388);
    });
});
