'use strict';

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_POLL_INTERVAL_SECONDS = 3600;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isMapFetchingEnabled(value) {
    return value === true;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isMapPathGenerationEnabled(value) {
    return value === true;
}

/**
 * @param {string|number|null|undefined} value
 * @returns {number}
 */
function normalizePollIntervalSeconds(value) {
    const parsed = Number(value);
    const intervalSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS;
    return Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(MIN_POLL_INTERVAL_SECONDS, intervalSeconds));
}

module.exports = {
    MAX_POLL_INTERVAL_SECONDS,
    MIN_POLL_INTERVAL_SECONDS,
    isMapFetchingEnabled,
    isMapPathGenerationEnabled,
    normalizePollIntervalSeconds,
};
