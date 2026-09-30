"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

function defaultRoutes() {
    const backdrop = require("../api/_lib/backdrop");
    const credit = require("../api/_lib/credit");
    const { createBackchannelHandler } = require("./backchannel");
    return {
        "/api/media": backdrop.handler,
        "/api/tint": backdrop.tintHandler,
        "/api/credit": credit.handler,
        "/api/backchannel": createBackchannelHandler(),
    };
}

function queryObject(searchParams) {
    const query = {};
    for (const [name, value] of searchParams) {
        if (!Object.prototype.hasOwnProperty.call(query, name)) {
            query[name] = value;
        } else if (Array.isArray(query[name])) {
            query[name].push(value);
        } else {
            query[name] = [query[name], value];
        }
    }
    return query;
}

function sendError(res, status, code) {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: code }));
}

function disableBrowserCache(res) {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name,
        String(name).toLowerCase() === "cache-control" ? "no-store" : value);
    res.setHeader("Cache-Control", "no-store");
}

function createRequestListener(routes) {
    return function localApiRequest(req, res) {
        let url;
        try {
            url = new URL(req.url, "http://localhost");
        } catch (error) {
            sendError(res, 400, "invalid_url");
            return;
        }
        if (/^\/ratings\/v1\/[a-z0-9_-]+\.[a-f0-9]{12}\.png$/.test(url.pathname)) {
            if (req.method !== "GET" && req.method !== "HEAD") {
                sendError(res, 405, "method_not_allowed"); return;
            }
            fs.readFile(path.join(__dirname, "..", "public", url.pathname)).then((png) => {
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader("Content-Length", png.length);
                res.end(req.method === "HEAD" ? undefined : png);
            }).catch(() => sendError(res, 404, "not_found"));
            return;
        }
        disableBrowserCache(res);
        const handler = routes[url.pathname];
        if (typeof handler !== "function") {
            sendError(res, 404, "not_found");
            return;
        }
        req.query = queryObject(url.searchParams);
        Promise.resolve().then(() => handler(req, res)).catch((error) => {
            console.error("[local-api] unhandled handler error", error);
            sendError(res, 500, "internal_error");
        });
    };
}

function createLocalApiServer(options = {}) {
    return http.createServer(createRequestListener(options.routes || defaultRoutes()));
}

if (require.main === module) {
    const port = Number.parseInt(process.env.LOCAL_API_PORT || "3000", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("LOCAL_API_PORT must be an integer from 1 to 65535");
    }
    const server = createLocalApiServer();
    server.listen(port, "127.0.0.1", () => {
        console.log(`[local-api] ready at http://localhost:${port}`);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

module.exports = { createLocalApiServer, queryObject };
