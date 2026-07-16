"use strict";

const assert = require("node:assert/strict");

const { getDeviceChannelDefinitions, getDeviceStateDefinitions } = require("../../../lib/adapter/definitions");

describe("lib/adapter/definitions map states", () => {
    const translate = text => text;

    it("defines a stable map channel and three read-only image states", () => {
        const channels = getDeviceChannelDefinitions(translate);
        const states = getDeviceStateDefinitions(translate);

        assert.deepEqual(channels.find(definition => definition[0] === "map"), ["map", "channel", "Map"]);
        assert.deepEqual(states["map.image"], {
            type: "string",
            role: "media.image",
            read: true,
            write: false,
            name: "Full map image",
        });
        assert.deepEqual(states["map.imageWithRtkMask"], {
            type: "string",
            role: "media.image",
            read: true,
            write: false,
            name: "Map image with RTK mask",
        });
        assert.deepEqual(states["map.imageWithMowedPath"], {
            type: "string",
            role: "media.image",
            read: true,
            write: false,
            name: "Map image with mowed path",
        });
        assert.equal(states["location.pose.x"].unit, "m");
        assert.equal(states["location.pose.y"].unit, "m");
    });

    it("defines the charger location channel and metre states", () => {
        const channels = getDeviceChannelDefinitions(translate);
        const states = getDeviceStateDefinitions(translate);

        assert.deepEqual(channels.find(definition => definition[0] === "location.charger"), [
            "location.charger",
            "channel",
            "Charger location",
        ]);
        assert.deepEqual(states["location.charger.x"], {
            type: "number",
            role: "value",
            read: true,
            write: false,
            unit: "m",
            name: "Charger X",
        });
        assert.deepEqual(states["location.charger.y"], {
            type: "number",
            role: "value",
            read: true,
            write: false,
            unit: "m",
            name: "Charger Y",
        });
    });
});
