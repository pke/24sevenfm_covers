"use strict";

// Shared resolver results, before projecting a client's optional response fields.
// The map belongs to one warm handler instance; concurrent requests share work.
function createMetadataCache({ limit = 256, now = Date.now } = {}) {
    const entries = new Map();
    return async function cachedMetadata(key, resolve, ttlSeconds, reload = false, report = () => {}) {
        const existing = entries.get(key);
        if (!reload && existing && existing.expires > now()) {
            report({ status: existing.expires === Infinity ? "coalesced" : "hit",
                ageMs: Math.max(0, now() - existing.createdAt) });
            entries.delete(key);
            entries.set(key, existing);
            return existing.promise;
        }
        report({ status: reload ? "reload" : "miss", ageMs: null });
        const entry = { expires: Infinity, promise: null, createdAt: now() };
        entry.promise = Promise.resolve().then(resolve).then(result => {
            entry.expires = now() + ttlSeconds(result) * 1000;
            return result;
        }).catch(error => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
        });
        entries.delete(key);
        entries.set(key, entry);
        while (entries.size > limit) entries.delete(entries.keys().next().value);
        return entry.promise;
    };
}

module.exports = { createMetadataCache };
