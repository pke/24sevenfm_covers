// Progressive enhancement: remember the resolved theme across visits. The checkbox
// flips relative to the OS scheme, so restore checked = saved XOR os-preference.
"use strict";
(function () {
    var box = document.getElementById("themeswitch");
    var scheme = matchMedia("(prefers-color-scheme: dark)");
    var saved = "";
    try { saved = localStorage.getItem("theme"); }
    catch (e) { /* unavailable: keep OS preference */ }

    function syncTheme() {
        if (saved === "dark" || saved === "light")
            box.checked = (saved === "dark") !== scheme.matches;
    }
    syncTheme();
    box.addEventListener("change", function () {
        saved = (scheme.matches !== box.checked) ? "dark" : "light";
        try { localStorage.setItem("theme", saved); }
        catch (e) { /* unavailable: keep the choice for this page only */ }
    });
    if (scheme.addEventListener) scheme.addEventListener("change", syncTheme);
    else if (scheme.addListener) scheme.addListener(syncTheme);
})();
