// Native WebViews are often top-level documents. Only a real host bridge opts in;
// an ordinary iframe does not imply external playback ownership.
(function (root) {
    "use strict";
    function create(context) {
        var bridge = context.iina;
        var nativeHost = !!(bridge && typeof bridge.postMessage === "function" && typeof bridge.onMessage === "function");
        var explicit = new URLSearchParams(context.location.search).get("embed") === "iina";
        var hosted = nativeHost || explicit;
        var state = { activity: "stop", station: "", mode: "hidden", title: "" }, listeners = [];
        var api = {
            hosted: hosted,
            get state() { return state; },
            get running() { return !hosted || (state.activity === "play" && state.mode !== "hidden" && !!state.station); },
            allowAudio: function () { return !hosted; },
            onState: function (listener) { listeners.push(listener); },
            post: function (name, data) { if (nativeHost) bridge.postMessage(name, data); }
        };
        if (hosted) {
            context.document.documentElement.dataset.playerHost = "iina";
            context.document.documentElement.dataset.hostPlayback = "stop";
            if (nativeHost) bridge.onMessage("covers-playback", function (next) {
                if (!next || ["play", "pause", "stop"].indexOf(next.activity) < 0 || ["sidebar", "overlay", "hidden"].indexOf(next.mode) < 0) return;
                var station = ["sst", "1980s", "adagio", "death", "entranced"].indexOf(next.station) >= 0 ? next.station : "";
                var previous = state;
                state = { activity: station ? next.activity : "stop", station: station, mode: next.mode, title: typeof next.title === "string" ? next.title : "" };
                context.document.documentElement.dataset.hostPlayback = state.activity;
                context.document.documentElement.dataset.hostMode = state.mode;
                listeners.forEach(function (listener) {
                    try { listener(state, previous); }
                    catch (error) { api.post("covers-error", { message:String(error), stack:error.stack || "" });throw error; }
                });
            });
        }
        return api;
    }
    root.PlayerHost = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
