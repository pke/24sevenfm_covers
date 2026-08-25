"use strict";

const STYLE_URL = new URL("../css/memory-game.css" + new URL(import.meta.url).search,
    import.meta.url).href;
const MIN_PAIRS = 5;
const MAX_PAIRS = 10;
const REQUEST_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 10000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let stylePromise = null;
let activeGame = null;
let openingGame = null;

function ensureStyles() {
    if (stylePromise) return stylePromise;
    stylePromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('link[data-memory-game-style]');
        if (existing) {
            if (existing.sheet) resolve();
            else {
                existing.addEventListener("load", resolve, { once: true });
                existing.addEventListener("error", reject, { once: true });
            }
            return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = STYLE_URL;
        link.dataset.memoryGameStyle = "";
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", reject, { once: true });
        document.head.appendChild(link);
    }).catch((error) => {
        stylePromise = null;
        throw error;
    });
    return stylePromise;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function randomInt(min, max) {
    const range = max - min + 1;
    if (window.crypto && window.crypto.getRandomValues) {
        const ceiling = Math.floor(0x100000000 / range) * range;
        const value = new Uint32Array(1);
        do { window.crypto.getRandomValues(value); } while (value[0] >= ceiling);
        return min + value[0] % range;
    }
    return min + Math.floor(Math.random() * range);
}

function shuffle(values) {
    const shuffled = values.slice();
    for (let index = shuffled.length - 1; index > 0; index--) {
        const other = randomInt(0, index);
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    return shuffled;
}

function decodeText(value) {
    if (value === null || value === undefined) return "";
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") return "";
    const safe = String(value).replace(/</g, "&lt;");
    return new DOMParser().parseFromString(safe, "text/html").body.textContent.trim();
}

function unrotateTitleArticle(title) {
    return (title || "").replace(
        /^(.+),\s*(The|A|An)(\s+\((?:18|19|20|21)\d{2}\))?$/i, "$2 $1$3");
}

function trustedCoverUrl(raw, host) {
    if (typeof raw !== "string" || !raw || /[\u0000-\u001F\u007F]/.test(raw)) return "";
    try {
        const url = new URL(raw);
        const imageHost = url.hostname.toLowerCase();
        const trustedHost = host.toLowerCase();
        if (url.protocol !== "https:" || (url.port && url.port !== "443")
                || url.username || url.password
                || (imageHost !== trustedHost && !imageHost.endsWith("." + trustedHost))) return "";
        return url.href.replace("/cover/", "/cover/500/");
    } catch (error) {
        return "";
    }
}

function queueEntry(value, source, config) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const title = unrotateTitleArticle(decodeText(value.Album));
    const coverUrl = trustedCoverUrl(value.CoverLink, config.host);
    if (!title || !coverUrl) return null;
    return {
        title,
        track: decodeText(value.Track),
        coverUrl,
        source,
    };
}

function uniqueEntries(values, source, config) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map((value) =>
        queueEntry(value, source, config)).filter((entry) => {
        if (!entry || seen.has(entry.coverUrl)) return false;
        seen.add(entry.coverUrl);
        return true;
    });
}

function loadImage(url) {
    return new Promise((resolve) => {
        const image = new Image();
        let settled = false;
        const timer = setTimeout(() => settle(false), IMAGE_TIMEOUT_MS);
        function settle(loaded) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = image.onerror = null;
            if (!loaded) image.removeAttribute("src");
            resolve(loaded);
        }
        image.onload = () => settle(image.naturalWidth > 0);
        image.onerror = () => settle(false);
        image.src = url;
        if (image.complete) queueMicrotask(() => settle(image.naturalWidth > 0));
    });
}

async function fetchList(action, config, signal) {
    const url = "https://" + config.host
        + "/soap/FM24sevenJSON.php?action=" + encodeURIComponent(action)
        + "&_t=" + Date.now();
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("Invalid " + action + " response");
    return value;
}

async function coverCatalog(config, signal) {
    const results = await Promise.allSettled([
        fetchList("GetQueue", config, signal),
        fetchList("GetHistory", config, signal),
    ]);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const upcoming = uniqueEntries(results[0].status === "fulfilled" ? results[0].value : [],
        "upcoming", config);
    const history = uniqueEntries(results[1].status === "fulfilled" ? results[1].value : [],
        "history", config);

    // A cover may occur on both feeds. Prefer its upcoming occurrence and expose only
    // unique candidates to the deck-size picker.
    const candidates = [];
    const seen = new Set();
    [...shuffle(upcoming), ...shuffle(history)].forEach((entry) => {
        if (seen.has(entry.coverUrl)) return;
        seen.add(entry.coverUrl);
        candidates.push(entry);
    });
    if (candidates.length < MIN_PAIRS)
        throw new Error("Fewer than five covers are available in the station queues right now.");
    return candidates;
}

function orderedCandidates(candidates, wanted) {
    const availableUpcoming = shuffle(candidates.filter((entry) => entry.source === "upcoming"));
    const availableHistory = shuffle(candidates.filter((entry) => entry.source === "history"));
    const selected = [];
    if (availableUpcoming.length) selected.push(availableUpcoming.pop());
    if (availableHistory.length) selected.push(availableHistory.pop());
    const alreadySelected = new Set(selected.map((entry) => entry.coverUrl));
    const remainder = shuffle(candidates.filter((entry) => !alreadySelected.has(entry.coverUrl)));
    selected.push(...remainder.slice(0, wanted - selected.length));
    const selectedUrls = new Set(selected.map((entry) => entry.coverUrl));
    return selected.concat(shuffle(candidates.filter((entry) => !selectedUrls.has(entry.coverUrl))));
}

async function downloadGameEntries(candidates, wanted, signal, onProgress) {
    const ordered = orderedCandidates(candidates, wanted);
    const ready = [];
    let cursor = wanted;
    const initial = ordered.slice(0, wanted);
    await Promise.all(initial.map(async (entry) => {
        const loaded = await loadImage(entry.coverUrl);
        if (signal.aborted) return;
        if (loaded) {
            ready.push(entry);
            onProgress(ready.length, wanted, entry);
        }
    }));
    while (!signal.aborted && ready.length < wanted && cursor < ordered.length) {
        const entry = ordered[cursor++];
        if (await loadImage(entry.coverUrl)) {
            ready.push(entry);
            onProgress(ready.length, wanted, entry);
        }
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (ready.length < wanted)
        throw new Error("Some cover art didn’t arrive, so there aren’t enough cards for that deck.");
    return shuffle(ready.slice(0, wanted));
}

function wait(duration) {
    return new Promise((resolve) => setTimeout(resolve, reducedMotion.matches ? 0 : duration));
}

function createGame(config) {
    const previousFocus = document.activeElement;
    const overlay = element("div", "memory-game-overlay");
    const shell = element("section", "memory-game-shell");
    const titleId = "memory-game-title";
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-labelledby", titleId);

    const header = element("header", "memory-game-header");
    const headingGroup = element("div", "memory-game-heading");
    const stationLogo = element("img", "memory-game-heading-logo");
    stationLogo.src = config.stationLogo;
    stationLogo.alt = "";
    const headingText = element("div");
    const eyebrow = element("span", "memory-game-eyebrow", "Secret frequency found");
    const title = element("h2", "memory-game-title", "Cover Memory");
    title.id = titleId;
    headingText.append(eyebrow, title);
    headingGroup.append(stationLogo, headingText);

    const actions = element("div", "memory-game-actions");
    const newGameButton = element("button", "memory-game-button memory-game-new", "Shuffle");
    newGameButton.type = "button";
    newGameButton.classList.add("is-hidden");
    const closeButton = element("button", "memory-game-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close Cover Memory");
    actions.append(newGameButton, closeButton);
    header.append(headingGroup, actions);

    const score = element("div", "memory-game-score");
    score.setAttribute("aria-live", "polite");
    const movesValue = element("strong", "memory-game-moves", "0");
    const pairsValue = element("strong", "memory-game-pairs", "0 / 0");
    const movesLabel = element("span", "", " moves");
    const divider = element("span", "memory-game-score-divider", "•");
    const pairsLabel = element("span", "", " pairs");
    score.append(movesValue, movesLabel, divider, pairsValue, pairsLabel);

    const viewport = element("div", "memory-game-viewport");
    const loading = loadingView(config.stationName);
    viewport.appendChild(loading);
    shell.append(header, score, viewport);
    overlay.appendChild(shell);
    document.querySelector(".page").appendChild(overlay);
    document.body.classList.add("memory-game-open");

    let closing = false;
    let controller = null;
    let round = 0;
    let swapSequence = Promise.resolve();

    function loadingView(stationName) {
        const view = element("div", "memory-game-view memory-game-loading");
        view.setAttribute("role", "status");
        const record = element("div", "memory-game-record");
        const recordLogo = element("img");
        recordLogo.src = config.stationLogo;
        recordLogo.alt = "";
        record.appendChild(recordLogo);
        view.append(record, element("p", "memory-game-loading-title", "Crate digging…"),
            element("p", "memory-game-loading-copy",
                "Mixing upcoming and recently played covers from " + stationName + "."));
        return view;
    }

    async function swapView(next) {
        swapSequence = swapSequence.then(async () => {
            if (closing) return;
            const outgoing = viewport.querySelector(".memory-game-view");
            const currentHeight = viewport.getBoundingClientRect().height;
            viewport.style.height = currentHeight + "px";
            if (outgoing) {
                outgoing.classList.add("is-exiting");
                await wait(180);
                if (closing) return;
                outgoing.remove();
            }
            next.classList.add("is-entering");
            viewport.appendChild(next);
            const targetHeight = next.scrollHeight;
            void next.offsetWidth;
            viewport.style.height = targetHeight + "px";
            next.classList.remove("is-entering");
            await wait(360);
            if (!closing && viewport.contains(next)) viewport.style.height = "auto";
        });
        return swapSequence;
    }

    function errorView(message) {
        const view = element("div", "memory-game-view memory-game-message");
        view.setAttribute("role", "alert");
        view.append(element("div", "memory-game-message-icon", "◌"),
            element("h3", "", "The crate came up short"),
            element("p", "", message));
        const retry = element("button", "memory-game-button", "Try another pull");
        retry.type = "button";
        retry.addEventListener("click", startRound);
        view.appendChild(retry);
        return view;
    }

    function selectionView(candidates, token) {
        const max = Math.min(MAX_PAIRS, candidates.length);
        const view = element("div", "memory-game-view memory-game-select");
        view.append(element("p", "memory-game-select-kicker", "Choose your deck"),
            element("h3", "memory-game-select-title", "How many covers?"),
            element("p", "memory-game-select-copy",
                "Pick 5–" + max + " covers. Each one appears twice as a matching pair."));
        const choices = element("div", "memory-game-size-choices");
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", "Number of covers");
        const deal = element("button", "memory-game-button memory-game-deal", "Choose a deck size");
        deal.type = "button";
        deal.disabled = true;
        let selected = 0;
        for (let count = MIN_PAIRS; count <= max; count++) {
            const choice = element("button", "memory-game-size-choice");
            choice.type = "button";
            choice.setAttribute("aria-pressed", "false");
            choice.setAttribute("aria-label", count + " covers, " + (count * 2) + " cards");
            choice.append(element("strong", "", String(count)), element("span", "", "covers"));
            choice.addEventListener("click", () => {
                selected = count;
                choices.querySelectorAll("button").forEach((button) => {
                    const active = button === choice;
                    button.classList.toggle("is-selected", active);
                    button.setAttribute("aria-pressed", active ? "true" : "false");
                });
                deal.disabled = false;
                deal.textContent = "Deal " + count + " pairs";
            });
            choices.appendChild(choice);
        }
        deal.addEventListener("click", () => {
            if (!selected || token !== round || deal.disabled) return;
            deal.disabled = true;
            choices.querySelectorAll("button").forEach((button) => { button.disabled = true; });
            dealRound(candidates, selected, token);
        });
        const available = element("p", "memory-game-available",
            candidates.length + " unique covers found across the upcoming and history queues.");
        view.append(choices, deal, available);
        return view;
    }

    function progressView(wanted) {
        const view = element("div", "memory-game-view memory-game-download");
        view.setAttribute("role", "status");
        view.setAttribute("aria-live", "polite");
        const stack = element("div", "memory-game-card-stack");
        for (let index = 0; index < 3; index++) {
            const card = element("span", "memory-game-stack-card");
            const logo = element("img");
            logo.src = config.stationLogo;
            logo.alt = "";
            card.appendChild(logo);
            stack.appendChild(card);
        }
        const title = element("p", "memory-game-loading-title", "Pulling the covers…");
        const copy = element("p", "memory-game-loading-copy", "0 of " + wanted + " covers ready");
        const track = element("div", "memory-game-progress");
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", "Cover downloads");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", String(wanted));
        track.setAttribute("aria-valuenow", "0");
        const bar = element("span", "memory-game-progress-bar");
        track.appendChild(bar);
        const pips = element("div", "memory-game-progress-pips");
        for (let index = 0; index < wanted; index++) pips.appendChild(element("span"));
        view.append(stack, title, copy, track, pips);
        return {
            view,
            update(loaded) {
                const percent = loaded / wanted * 100;
                bar.style.width = percent + "%";
                track.setAttribute("aria-valuenow", String(loaded));
                copy.textContent = loaded + " of " + wanted + " covers ready";
                Array.from(pips.children).forEach((pip, index) =>
                    pip.classList.toggle("is-loaded", index < loaded));
            },
        };
    }

    function boardView(entries) {
        let firstCard = null;
        let locked = false;
        let moves = 0;
        let matched = 0;
        movesValue.textContent = "0";
        pairsValue.textContent = "0 / " + entries.length;
        newGameButton.textContent = "Shuffle";

        const view = element("div", "memory-game-view memory-game-play");
        const intro = element("p", "memory-game-intro",
            entries.length + " covers from the upcoming and history queues. Find every pair.");
        const board = element("div", "memory-game-board");
        board.dataset.pairs = String(entries.length);
        board.setAttribute("aria-label", "Memory card grid");
        const announcement = element("p", "visually-hidden");
        announcement.setAttribute("aria-live", "polite");

        const deck = shuffle(entries.flatMap((entry, pair) => [
            { entry, pair, copy: 0 }, { entry, pair, copy: 1 },
        ]));
        deck.forEach((item, index) => {
            const card = element("button", "memory-game-card");
            card.type = "button";
            card.dataset.pair = String(item.pair);
            card.dataset.copy = String(item.copy);
            card.setAttribute("aria-label", "Face-down card " + (index + 1) + " of " + deck.length);
            const inner = element("span", "memory-game-card-inner");
            const back = element("span", "memory-game-card-face memory-game-card-back");
            const backLogo = element("img");
            backLogo.src = config.stationLogo;
            backLogo.alt = "";
            back.appendChild(backLogo);
            const cover = element("span", "memory-game-card-face memory-game-card-cover");
            const coverImage = element("img");
            coverImage.src = item.entry.coverUrl;
            coverImage.alt = "";
            cover.appendChild(coverImage);
            inner.append(back, cover);
            card.appendChild(inner);

            card.addEventListener("click", async () => {
                if (locked || card === firstCard || card.classList.contains("is-matched")) return;
                card.classList.add("is-flipped");
                card.setAttribute("aria-label", item.entry.title + (item.entry.track
                    ? " — " + item.entry.track : "") + ", selected");
                if (!firstCard) {
                    firstCard = card;
                    return;
                }

                locked = true;
                moves++;
                movesValue.textContent = String(moves);
                const other = firstCard;
                firstCard = null;
                if (other.dataset.pair === card.dataset.pair) {
                    await wait(430);
                    other.classList.add("is-matched");
                    card.classList.add("is-matched");
                    other.setAttribute("aria-disabled", "true");
                    card.setAttribute("aria-disabled", "true");
                    other.setAttribute("aria-label", item.entry.title + ", matched");
                    card.setAttribute("aria-label", item.entry.title + ", matched");
                    matched++;
                    pairsValue.textContent = matched + " / " + entries.length;
                    announcement.textContent = "Matched " + item.entry.title + ". "
                        + matched + " of " + entries.length + " pairs found.";
                    if (matched === entries.length) {
                        view.classList.add("is-won");
                        newGameButton.textContent = "Play again";
                        announcement.textContent = "You found all " + entries.length
                            + " pairs in " + moves + " moves.";
                    }
                } else {
                    await wait(780);
                    other.classList.remove("is-flipped");
                    card.classList.remove("is-flipped");
                    const cardNumber = (button) => Array.prototype.indexOf.call(board.children, button) + 1;
                    other.setAttribute("aria-label", "Face-down card " + cardNumber(other)
                        + " of " + deck.length);
                    card.setAttribute("aria-label", "Face-down card " + cardNumber(card)
                        + " of " + deck.length);
                    announcement.textContent = "No match. Choose again.";
                }
                locked = false;
            });
            board.appendChild(card);
        });
        view.append(intro, board, announcement);
        return view;
    }

    async function dealRound(candidates, wanted, token) {
        if (closing || token !== round) return;
        newGameButton.disabled = true;
        const progress = progressView(wanted);
        await swapView(progress.view);
        if (closing || token !== round) return;
        try {
            const entries = await downloadGameEntries(candidates, wanted, controller.signal,
                (loaded) => progress.update(loaded));
            if (closing || token !== round) return;
            await wait(280);
            await swapView(boardView(entries));
            if (!closing && token === round) {
                newGameButton.disabled = false;
                newGameButton.classList.remove("is-hidden");
                score.classList.remove("is-muted");
            }
        } catch (error) {
            if (closing || token !== round) return;
            const message = error && error.name === "AbortError"
                ? "The cover download took too long."
                : (error && error.message || "The covers couldn’t be loaded.");
            await swapView(errorView(message));
        }
    }

    async function startRound() {
        const token = ++round;
        if (controller) controller.abort();
        controller = new AbortController();
        newGameButton.disabled = true;
        newGameButton.classList.add("is-hidden");
        score.classList.add("is-muted");
        if (!viewport.querySelector(".memory-game-loading"))
            await swapView(loadingView(config.stationName));
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const candidates = await coverCatalog(config, controller.signal);
            if (closing || token !== round) return;
            await swapView(selectionView(candidates, token));
        } catch (error) {
            if (closing || token !== round) return;
            const message = error && error.name === "AbortError"
                ? "The station took too long to answer."
                : (error && error.message || "The station queues couldn’t be loaded.");
            await swapView(errorView(message));
        } finally {
            clearTimeout(timeout);
            if (!closing && token === round) {
                newGameButton.disabled = true;
            }
        }
    }

    async function close() {
        if (closing) return;
        closing = true;
        round++;
        if (controller) controller.abort();
        overlay.classList.add("is-closing");
        await wait(260);
        overlay.remove();
        document.body.classList.remove("memory-game-open");
        if (previousFocus && previousFocus.isConnected && previousFocus.focus)
            previousFocus.focus({ preventScroll: true });
        if (activeGame && activeGame.overlay === overlay) activeGame = null;
        document.removeEventListener("keydown", onKeyDown);
    }

    function onKeyDown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(shell.querySelectorAll("button:not([disabled])"));
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    closeButton.addEventListener("click", close);
    newGameButton.addEventListener("click", startRound);
    overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) close();
    });
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => {
        overlay.classList.add("is-open");
        closeButton.focus({ preventScroll: true });
    });
    startRound();
    return { overlay, close };
}

export async function openMemoryGame(config) {
    if (!config || !config.host || !config.stationLogo || !config.stationName) return;
    if (activeGame) {
        activeGame.overlay.querySelector(".memory-game-close").focus({ preventScroll: true });
        return;
    }
    if (!openingGame) {
        openingGame = ensureStyles().then(() => {
            if (!activeGame) activeGame = createGame(config);
        }).finally(() => { openingGame = null; });
    }
    await openingGame;
}
