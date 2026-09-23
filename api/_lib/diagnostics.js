"use strict";
// Bounded measurements, isolated across concurrent requests and cache producers.
// Cached work keeps its creation timestamp; it is never relabelled as fresh work.
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const storage = new AsyncLocalStorage();
const failedWork = Symbol("failed diagnostic work");
const milliseconds = start => Math.round((performance.now() - start) * 100) / 100;

function safeUrl(raw) {
    try {
        const url = new URL(raw);
        url.username = ""; url.password = ""; url.hash = "";
        for (const key of Array.from(url.searchParams.keys())) {
            if (/key|token|secret|auth|password|credential/i.test(key)) url.searchParams.set(key, "[redacted]");
        }
        return url.href;
    } catch { return "[invalid URL]"; }
}
function context() {
    return { started: performance.now(), recordedAt: new Date().toISOString(), spans: [], images: [], selections: [] };
}
function runRequest(req, callback) {
    return storage.run({ ...context(), requestId: randomUUID(), cache: {},
        enabled: req.query && req.query.diagnostics === "1" }, callback);
}
function validOption(req) {
    const value = req.query && req.query.diagnostics;
    return value === undefined || value === "0" || value === "1";
}
function response(body) {
    const current = storage.getStore();
    if (!current || !current.enabled) return body;
    const { started, enabled, ...details } = current;
    return { ...body, diagnostics: { ...details, totalMs: milliseconds(started) } };
}
function span(name, url) {
    const current = storage.getStore(), started = performance.now();
    const result = { name, offsetMs: current ? milliseconds(current.started) : 0,
        ...(url ? { url: safeUrl(url) } : {}), status: null, headersMs: null, totalMs: null };
    if (current && current.spans.length < 64) current.spans.push(result);
    return { headers(status) { result.status = status; result.headersMs = milliseconds(started); },
        finish(status) { if (status !== undefined) result.status = status; result.totalMs = milliseconds(started); } };
}
function image(url) {
    const current = storage.getStore(), started = performance.now();
    const result = { url: safeUrl(url), offsetMs: current ? milliseconds(current.started) : 0,
        status: "pending", httpStatus: null, headersMs: null, downloadMs: null, analysisMs: null,
        totalMs: null, bytes: null, width: null, height: null, format: null, error: null };
    if (current && current.images.length < 8) current.images.push(result);
    return { result, headers(status) { result.httpStatus = status; result.headersMs = milliseconds(started); },
        downloaded(bytes) { result.bytes = bytes; result.downloadMs = milliseconds(started); },
        finish(status, error) { result.status = status; result.totalMs = milliseconds(started); result.error = error || null; } };
}
function selection(value) {
    const current = storage.getStore();
    if (current && current.selections.length < 16) current.selections.push(value);
}
async function cached(cache, name, key, resolve, ttl, reload) {
    const request = storage.getStore();
    const outcome = {};
    const field = name === "metadata" ? "resolution" : "logoResolution";
    try {
        const work = await cache(key, async () => {
            const creation = context();
            return storage.run(creation, async () => {
                let value;
                try { value = await resolve(); }
                catch (error) {
                    const { started, ...details } = creation;
                    if (error && typeof error === "object")
                        error[failedWork] = { ...details, totalMs: milliseconds(started) };
                    throw error;
                }
                const { started, ...details } = creation;
                return { value, diagnostics: { ...details, totalMs: milliseconds(started) } };
            });
        }, entry => ttl(entry.value), reload, info => Object.assign(outcome, info));
        if (request) request[field] = work.diagnostics;
        return work.value;
    } catch (error) {
        if (request && error && error[failedWork]) request[field] = error[failedWork];
        throw error;
    } finally {
        if (request) request.cache[name] = outcome;
    }
}
module.exports = { runRequest, validOption, response, span, image, selection, cached, milliseconds, safeUrl };
