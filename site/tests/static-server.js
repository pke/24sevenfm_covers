const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const args = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2)
    args[process.argv[index]] = process.argv[index + 1];

const root = path.resolve(args["--root"] || "");
const port = Number(args["--port"]);
if (!args["--root"] || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Usage: node static-server.js --root <directory> --port <port>");

const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".xml": "application/xml"
};

const server = http.createServer((request, response) => {
    let requestPath;
    try { requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch (error) { response.writeHead(400).end(); return; }
    if (requestPath === "/") requestPath = "/index.html";
    const file = path.resolve(root, `.${requestPath}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
        response.writeHead(404).end();
        return;
    }
    fs.readFile(file, (error, body) => {
        if (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500).end(); return; }
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": contentTypes[path.extname(file).toLowerCase()]
                || "application/octet-stream"
        });
        response.end(body);
    });
});

server.on("error", (error) => { throw error; });
server.listen(port, "127.0.0.1", () =>
    process.stdout.write(`Serving ${root} on http://127.0.0.1:${port}/\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
