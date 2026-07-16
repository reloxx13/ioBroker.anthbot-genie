"use strict";

const assert = require("node:assert/strict");

const { AnthbotCloudApiClient, AnthbotShadowApiClient } = require("../../../lib/anthbot");

describe("lib/anthbot clients", () => {
    const tempCredentials = {
        accessKeyId: "ASIA123",
        secretAccessKey: "secret",
        sessionToken: "session",
    };

    it("keeps M-series param_set command payloads sparse when no cutter height is involved", async () => {
        const payloads = [];
        const client = new AnthbotShadowApiClient({
            http: {
                post: async (_url, payloadBytes) => {
                    payloads.push(JSON.parse(payloadBytes.toString("utf8")));
                    return {
                        status: 200,
                        data: { ok: true },
                        headers: {},
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            deviceModel: "Anthbot M5",
            iotCredentials: tempCredentials,
        });

        await client.publishServiceCommand({
            cmd: "param_set",
            data: { mow_count: 3, rid_switch: 1 },
        });

        assert.deepEqual(payloads[0], {
            state: {
                desired: {
                    cmd: "param_set",
                    data: {
                        mow_count: 3,
                        rid_switch: 1,
                    },
                },
            },
        });
    });

    it("builds stable cloud verification tokens for a fixed timestamp", () => {
        assert.equal(
            AnthbotCloudApiClient.buildVerificationToken("SERIAL123", 1711974896),
            "e74a008a1c0019cfa518153efcd4d2c61711974896",
        );
    });

    it("downloads the native multi-map archive using the mower map file name", async () => {
        const requests = [];
        const archive = Buffer.from([31, 139, 8, 0]);
        const client = new AnthbotCloudApiClient({
            http: {
                get: async (url, options) => {
                    requests.push({ url, options });
                    if (url.includes("presigned_url")) {
                        return {
                            status: 200,
                            data: { code: 0, data: { presigned_url: "https://download.example/map.gz" } },
                        };
                    }
                    return { status: 200, data: archive };
                },
            },
            host: "api.anthbot.com",
            bearerToken: "Bearer token",
        });

        assert.deepEqual(await client.getDeviceMapArchive("SERIAL123", "map_SERIAL123_0"), archive);
        assert.equal(requests[0].options.params.filename, "map_SERIAL123_0");
        assert.equal(requests[0].options.params.sub_category, "multi_maps");
        assert.equal(requests[1].options.responseType, "arraybuffer");
    });

    it("downloads the historical mowing path from the device path category", async () => {
        const requests = [];
        const pathFile = Buffer.from("0,0\n10,20\n", "utf8");
        const client = new AnthbotCloudApiClient({
            http: {
                get: async (url, options) => {
                    requests.push({ url, options });
                    if (url.includes("presigned_url")) {
                        return {
                            status: 200,
                            data: { code: 0, data: { presigned_url: "https://download.example/path.txt" } },
                        };
                    }
                    return { status: 200, data: pathFile };
                },
            },
            host: "api.anthbot.com",
            bearerToken: "Bearer token",
        });

        assert.deepEqual(await client.getDeviceHistoryPath("SERIAL123"), pathFile);
        assert.equal(requests[0].options.params.filename, "path_SERIAL123.txt");
        assert.equal(requests[0].options.params.sub_category, "path");
        assert.equal(requests[1].options.responseType, "arraybuffer");
    });

    it("parses temporary IoT credentials from the Anthbot STS endpoint", async () => {
        const client = new AnthbotCloudApiClient({
            http: {
                post: async (url, body, options) => {
                    assert.equal(url, "https://api.anthbot.com/api/v1/device/v2/iot/sts/arn");
                    assert.equal(body.sn, "SERIAL123");
                    assert.equal(typeof body.verification_token, "string");
                    assert.equal(options.headers.Authorization, "Bearer token");
                    return {
                        status: 200,
                        data: {
                            code: 0,
                            data: {
                                access_key_id: "ASIA123",
                                secret_access_key: "secret",
                                session_token: "session",
                                region_name: "eu-central-1",
                                endpoint: "a.example.iot.eu-central-1.amazonaws.com",
                                expiration: 3600,
                            },
                        },
                    };
                },
            },
            host: "api.anthbot.com",
            bearerToken: "Bearer token",
        });

        const credentials = await client.getDeviceIotCredentials("SERIAL123");

        assert.equal(credentials.accessKeyId, "ASIA123");
        assert.equal(credentials.secretAccessKey, "secret");
        assert.equal(credentials.sessionToken, "session");
        assert.equal(credentials.regionName, "eu-central-1");
        assert.equal(credentials.endpoint, "a.example.iot.eu-central-1.amazonaws.com");
        assert.equal(credentials.expiresAt > Date.now(), true);
    });

    it("fetches the Anthbot event code version", async () => {
        const client = new AnthbotCloudApiClient({
            http: {
                get: async (url, options) => {
                    assert.equal(url, "https://api.anthbot.com/api/v1/message/code/version");
                    assert.equal(options.headers.Authorization, "Bearer token");
                    return {
                        status: 200,
                        data: {
                            code: 0,
                            data: { version: 336 },
                        },
                    };
                },
            },
            host: "api.anthbot.com",
            bearerToken: "Bearer token",
        });

        assert.equal(await client.getEventCodeVersion(), 336);
    });

    it("fetches Anthbot event code translations for a version", async () => {
        const payload = {
            code: 0,
            data: {
                "2012": {
                    English: { event_message: "The machine is stuck" },
                },
            },
            msg: "success",
        };
        const client = new AnthbotCloudApiClient({
            http: {
                post: async (url, body, options) => {
                    assert.equal(url, "https://api.anthbot.com/api/v1/message/code/translate");
                    assert.deepEqual(body, { version: 336 });
                    assert.equal(options.headers.Authorization, "Bearer token");
                    return {
                        status: 200,
                        data: payload,
                    };
                },
            },
            host: "api.anthbot.com",
            bearerToken: "Bearer token",
        });

        assert.deepEqual(await client.getEventCodeTranslations(336), payload);
    });

    it("signs shadow requests with temporary AWS session tokens", async () => {
        const requests = [];
        const client = new AnthbotShadowApiClient({
            http: {
                get: async (url, options) => {
                    requests.push({ url, options });
                    return {
                        status: 200,
                        data: {
                            state: {
                                reported: { ok: true },
                            },
                        },
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            iotCredentials: tempCredentials,
        });

        await client.getNamedShadowReportedState("property");

        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.headers["x-amz-security-token"], "session");
        assert.match(requests[0].options.headers.Authorization, /Credential=ASIA123\//);
        assert.match(requests[0].options.headers.Authorization, /SignedHeaders=.*x-amz-security-token/);
    });

    it("requires temporary credentials for shadow access", async () => {
        const client = new AnthbotShadowApiClient({
            http: {
                get: async () => {
                    throw new Error("request should not be sent without temporary credentials");
                },
            },
            serialNumber: "SERIAL123",
            regionName: "us-east-1",
            iotEndpoint: "a2bhy9nr7jkgaj-ats.iot.us-east-1.amazonaws.com",
        });

        await assert.rejects(
            client.getNamedShadowReportedState("property"),
            /Temporary IoT credentials are required for shadow access/,
        );
    });

    it("refreshes IoT credentials once after a shadow 403", async () => {
        let getCount = 0;
        let refreshCount = 0;
        const client = new AnthbotShadowApiClient({
            http: {
                get: async (_url, options) => {
                    getCount++;
                    if (getCount === 1) {
                        assert.equal(options.headers["x-amz-security-token"], "expired-session");
                        return {
                            status: 403,
                            data: { message: "Forbidden" },
                        };
                    }
                    assert.equal(options.headers["x-amz-security-token"], "fresh-session");
                    return {
                        status: 200,
                        data: {
                            state: {
                                reported: { ok: true },
                            },
                        },
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            accountClient: {
                getDeviceIotCredentials: async serialNumber => {
                    refreshCount++;
                    assert.equal(serialNumber, "SERIAL123");
                    return {
                        accessKeyId: "ASIA456",
                        secretAccessKey: "secret2",
                        sessionToken: "fresh-session",
                        regionName: "eu-central-1",
                        endpoint: "a.example.iot.eu-central-1.amazonaws.com",
                    };
                },
            },
            iotCredentials: {
                accessKeyId: "ASIA123",
                secretAccessKey: "secret",
                sessionToken: "expired-session",
            },
        });

        assert.deepEqual(await client.getNamedShadowReportedState("property"), { ok: true });
        assert.equal(getCount, 2);
        assert.equal(refreshCount, 1);
    });

    it("does not retry or refresh credentials after a shadow 429", async () => {
        let getCount = 0;
        let refreshCount = 0;
        const client = new AnthbotShadowApiClient({
            http: {
                get: async () => {
                    getCount += 1;
                    return {
                        status: 429,
                        data: { message: "TOO_MANY_REQUESTS" },
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            accountClient: {
                getDeviceIotCredentials: async () => {
                    refreshCount += 1;
                    return tempCredentials;
                },
            },
            iotCredentials: tempCredentials,
        });

        await assert.rejects(client.getNamedShadowReportedState("property"), /Shadow request failed \(429\)/);
        assert.equal(getCount, 1);
        assert.equal(refreshCount, 0);
    });

    it("reads the actual service shadow for M-series devices", async () => {
        const urls = [];
        const client = new AnthbotShadowApiClient({
            http: {
                get: async url => {
                    urls.push(url);
                    return {
                        status: 200,
                        data: {
                            state: {
                                reported: { cmd: "find_robot" },
                            },
                        },
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            deviceModel: "Anthbot M5",
            iotCredentials: tempCredentials,
        });

        assert.deepEqual(await client.getServiceReportedState(), { cmd: "find_robot" });
        assert.equal(urls.length, 1);
        assert.match(urls[0], /[?]name=service$/);
    });

    it("shapes M-series service payloads for param_set and volume_ctl", async () => {
        const payloads = [];
        const client = new AnthbotShadowApiClient({
            http: {
                post: async (_url, payloadBytes) => {
                    payloads.push(JSON.parse(payloadBytes.toString("utf8")));
                    return {
                        status: 200,
                        data: { ok: true },
                        headers: {},
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            deviceModel: "Anthbot M5",
            iotCredentials: tempCredentials,
        });

        await client.publishServiceCommand({
            cmd: "param_set",
            data: { cutter_height: 45, mow_count: 2 },
        });
        await client.publishServiceCommand({
            cmd: "volume_ctl",
            data: { volume: 67 },
        });

        assert.deepEqual(payloads[0], {
            state: {
                desired: {
                    cmd: "param_set",
                    data: {
                        mow_count: 2,
                        cutter_ctl_cutter_lift: 45,
                    },
                },
            },
        });
        assert.deepEqual(payloads[1], {
            state: {
                desired: {
                    cmd: "volume_ctl",
                    data: {
                        volume_ctl: 67,
                    },
                },
            },
        });
    });

    it("keeps legacy shadow command payloads unchanged", async () => {
        const payloads = [];
        const client = new AnthbotShadowApiClient({
            http: {
                post: async (_url, payloadBytes) => {
                    payloads.push(JSON.parse(payloadBytes.toString("utf8")));
                    return {
                        status: 200,
                        data: { ok: true },
                        headers: {},
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            deviceModel: "Anthbot Genie 600",
            iotCredentials: tempCredentials,
        });

        await client.publishServiceCommand({
            cmd: "param_set",
            data: { cutter_height: 45, mow_count: 2 },
        });

        assert.deepEqual(payloads[0], {
            state: {
                desired: {
                    cmd: "param_set",
                    data: {
                        cutter_height: 45,
                        mow_count: 2,
                    },
                },
            },
        });
    });

    it("refreshes IoT credentials once after command publish 403s", async () => {
        let postCount = 0;
        let refreshCount = 0;
        const client = new AnthbotShadowApiClient({
            http: {
                post: async (_url, _payloadBytes, options) => {
                    postCount++;
                    const sessionToken = options.headers["x-amz-security-token"];
                    if (sessionToken === "expired-session") {
                        return {
                            status: 403,
                            data: { message: "Forbidden" },
                            headers: {},
                        };
                    }
                    assert.equal(sessionToken, "fresh-session");
                    return {
                        status: 200,
                        data: { ok: true },
                        headers: {},
                    };
                },
            },
            serialNumber: "SERIAL123",
            regionName: "eu-central-1",
            iotEndpoint: "a.example.iot.eu-central-1.amazonaws.com",
            accountClient: {
                getDeviceIotCredentials: async () => {
                    refreshCount++;
                    return {
                        accessKeyId: "ASIA456",
                        secretAccessKey: "secret2",
                        sessionToken: "fresh-session",
                        regionName: "eu-central-1",
                        endpoint: "a.example.iot.eu-central-1.amazonaws.com",
                    };
                },
            },
            iotCredentials: {
                accessKeyId: "ASIA123",
                secretAccessKey: "secret",
                sessionToken: "expired-session",
            },
        });

        await client.publishServiceCommand({ cmd: "find_robot" });

        assert.equal(refreshCount, 1);
        assert.equal(postCount, 8);
    });
});
