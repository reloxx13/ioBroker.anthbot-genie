"use strict";

const assert = require("node:assert/strict");

const adminConfig = require("../../../admin/jsonConfig.json");
const ioPackage = require("../../../io-package.json");
const {
    isMapFetchingEnabled,
    isMapPathGenerationEnabled,
    normalizePollIntervalSeconds,
} = require("../../../lib/adapter/config");

describe("adapter config helpers", () => {
    describe("normalizePollIntervalSeconds", () => {
        it("uses the default poll interval for missing or invalid values", () => {
            assert.equal(normalizePollIntervalSeconds(undefined), 60);
            assert.equal(normalizePollIntervalSeconds("not a number"), 60);
        });

        it("clamps poll interval values to the supported code-level range", () => {
            assert.equal(normalizePollIntervalSeconds(5), 10);
            assert.equal(normalizePollIntervalSeconds(120), 120);
            assert.equal(normalizePollIntervalSeconds(7200), 3600);
        });
    });

    describe("map fetching", () => {
        it("defaults map fetching to disabled in admin and native configuration", () => {
            assert.deepEqual(adminConfig.items.fetchMap, {
                type: "checkbox",
                label: "Fetch map (high CPU usage)",
                help: "Download and render map images, RTK mask, and historical mowing path",
                xs: 12,
                sm: 12,
                md: 6,
                lg: 6,
                xl: 6,
            });
            assert.equal(ioPackage.native.fetchMap, false);
            assert.deepEqual(adminConfig.items.generateMapWithPaths, {
                type: "checkbox",
                label: "Generate map with paths (even higher CPU usage)",
                help: "Download and render the historical mowing path in the map image",
                xs: 12,
                sm: 12,
                md: 6,
                lg: 6,
                xl: 6,
            });
            assert.equal(ioPackage.native.generateMapWithPaths, false);
        });

        it("only enables map fetching for an explicit true value", () => {
            assert.equal(isMapFetchingEnabled(true), true);
            assert.equal(isMapFetchingEnabled(false), false);
            assert.equal(isMapFetchingEnabled(undefined), false);
            assert.equal(isMapFetchingEnabled("true"), false);
            assert.equal(isMapPathGenerationEnabled(true), true);
            assert.equal(isMapPathGenerationEnabled(false), false);
            assert.equal(isMapPathGenerationEnabled("true"), false);
        });
    });
});
