"use strict";

const http = require("node:http");

function defaultRoutes() {
    const backdrop = require("../api/_lib/backdrop");
    const credit = require("../api/_lib/credit");
    return {
        "/api/backdrop": backdrop.handler,
        "/api/tint": backdrop.tintHandler,
        "/api/credit": credit.handler,
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
        disableBrowserCache(res);
        let url;
        try {
            url = new URL(req.url, "http://localhost");
        } catch (error) {
            sendError(res, 400, "invalid_url");
            return;
        }
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
    server.listen(port, "localhost", () => {
        console.log(`[local-api] ready at http://localhost:${port}`);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

module.exports = { createLocalApiServer, queryObject };
