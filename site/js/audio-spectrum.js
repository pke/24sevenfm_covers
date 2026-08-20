// A compact Winamp-style spectrum, loaded only after the listener first requests
// audio. The media element stays the one source of truth: Web Audio observes its
// decoded samples and forwards them to the speakers. If Web Audio is unavailable,
// normal <audio> playback continues without visualization.
export function createAudioSpectrumController({
    audioElement,
    spectrumElement,
    infoElement,
    getOptions,
    isAudioWanted,
    hasAudioPlayed,
    reducedMotion
}) {
    const spectrumCtx = spectrumElement.getContext("2d");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const ENVELOPE_MS = 400;
    let audioContext = null;
    let source = null;
    let analyser = null;
    let data = null;
    let frame = null;
    let lastFrame = 0;
    let peaks = [];
    let envelope = 0;
    let envelopeFrom = 0;
    let envelopeTarget = 0;
    let envelopeStarted = 0;

    function resize() {
        const rect = spectrumElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const scale = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(rect.width * scale));
        const height = Math.max(1, Math.round(rect.height * scale));
        if (spectrumElement.width === width && spectrumElement.height === height) return;
        spectrumElement.width = width;
        spectrumElement.height = height;
        peaks = [];
    }

    function clear() {
        peaks = [];
        lastFrame = 0;
        if (spectrumCtx)
            spectrumCtx.clearRect(0, 0, spectrumElement.width, spectrumElement.height);
    }

    function updateEnvelope(timestamp) {
        const progress = Math.min(1,
            Math.max(0, (timestamp - envelopeStarted) / ENVELOPE_MS));
        const eased = progress * progress * (3 - 2 * progress);
        envelope = envelopeFrom + (envelopeTarget - envelopeFrom) * eased;
        return progress >= 1;
    }

    function targetEnvelope(target) {
        if (envelopeTarget === target) return;
        const now = performance.now();
        updateEnvelope(now);
        envelopeFrom = envelope;
        envelopeTarget = target;
        envelopeStarted = now;
    }

    function playerTintRgb() {
        const channels = getComputedStyle(infoElement).color.match(/[\d.]+/g);
        return channels && channels.length >= 3
            ? channels.slice(0, 3).map(value => Math.round(Number(value)))
            : [255, 255, 255];
    }

    function rgba(rgb, alpha) {
        return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    }

    function draw(timestamp) {
        frame = null;
        if (timestamp - lastFrame < 33) {
            frame = requestAnimationFrame(draw);
            return;
        }
        lastFrame = timestamp;
        const envelopeDone = updateEnvelope(timestamp);
        if (envelopeTarget === 0 && envelopeDone) {
            envelope = envelopeFrom = 0;
            clear();
            spectrumElement.classList.remove("active");
            return;
        }
        resize();
        // During release the buffer intentionally keeps the last live frame, so every
        // bar falls from its own height instead of snapping to the analyser's zeroes.
        if (envelopeTarget === 1) analyser.getByteFrequencyData(data);

        const options = getOptions();
        const width = spectrumElement.width;
        const height = spectrumElement.height;
        const bars = Math.min(options.spectrumBars, data.length);
        const blockGap = Math.max(1, Math.round(width / 220));
        const gap = width >= bars * 2 + blockGap * (bars - 1) ? blockGap : 0;
        const barWidth = Math.max(1, Math.floor((width - gap * (bars - 1)) / bars));
        const plotWidth = barWidth * bars + gap * (bars - 1);
        const plotLeft = Math.max(0, Math.floor((width - plotWidth) * 0.5));
        const usableHeight = height - Math.max(3, Math.round(height * .08));
        const gradient = spectrumCtx.createLinearGradient(0, height, 0, 0);
        let tint = null;
        if (options.spectrumMode === "tinted") {
            tint = playerTintRgb();
            gradient.addColorStop(0, rgba(tint, .24));
            gradient.addColorStop(.58, rgba(tint, .48));
            gradient.addColorStop(.8, rgba(tint, .72));
            gradient.addColorStop(1, rgba(tint, 1));
        } else {
            gradient.addColorStop(0, "#36ed64");
            gradient.addColorStop(.58, "#6df052");
            gradient.addColorStop(.8, "#ffd43b");
            gradient.addColorStop(1, "#ff4b55");
        }
        spectrumCtx.clearRect(0, 0, width, height);
        spectrumCtx.fillStyle = gradient;

        for (let i = 0; i < bars; i++) {
            const position = bars === 1 ? 0 : i / (bars - 1);
            const bin = Math.min(data.length - 1,
                Math.floor(Math.pow(position, 1.65) * (data.length - 1)));
            let barHeight = Math.floor((data[bin] / 255) * usableHeight * envelope);
            const segment = blockGap * 3;
            barHeight = Math.floor(barHeight / segment) * segment;
            const x = plotLeft + Math.round(i * (barWidth + gap));
            spectrumCtx.fillRect(x, height - barHeight, barWidth, barHeight);
            const peak = peaks[i] || 0;
            peaks[i] = envelopeTarget === 0
                ? Math.min(peak || barHeight, barHeight)
                : barHeight >= peak
                    ? barHeight : Math.max(0, peak - Math.max(1, height * .025));
        }

        // Cut horizontal gaps into the gradient bars for the blocky Winamp look.
        for (let y = height - blockGap * 2; y > 0; y -= blockGap * 3)
            spectrumCtx.clearRect(0, y, width, blockGap);
        for (let i = 0; i < bars; i++) {
            const peakHeight = peaks[i];
            if (peakHeight <= 0) continue;
            const ratio = peakHeight / usableHeight;
            spectrumCtx.fillStyle = tint
                ? rgba(tint, Math.min(1, .45 + ratio * .55))
                : ratio > .8 ? "#ff6269" : ratio > .58 ? "#ffe163" : "#8aff79";
            spectrumCtx.fillRect(plotLeft + Math.round(i * (barWidth + gap)),
                Math.max(0, height - peakHeight - blockGap), barWidth, blockGap);
        }
        frame = requestAnimationFrame(draw);
    }

    function sync() {
        const options = getOptions();
        const active = !!(options.spectrumEnabled && isAudioWanted() && hasAudioPlayed()
            && spectrumCtx && analyser && !reducedMotion.matches);
        if (active) {
            if (!document.hidden) {
                spectrumElement.classList.add("active");
                targetEnvelope(1);
                resize();
                if (frame === null) frame = requestAnimationFrame(draw);
            }
            return;
        }
        if (!document.hidden && !reducedMotion.matches
                && spectrumElement.classList.contains("active") && envelope > 0) {
            targetEnvelope(0);
            if (frame === null) frame = requestAnimationFrame(draw);
            return;
        }
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        envelope = envelopeFrom = envelopeTarget = 0;
        spectrumElement.classList.remove("active");
        clear();
    }

    function prepare() {
        if (!getOptions().spectrumEnabled || !spectrumCtx || !AudioContextCtor
                || reducedMotion.matches) return false;
        if (!analyser) {
            try {
                audioContext = new AudioContextCtor();
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 128;
                analyser.smoothingTimeConstant = .78;
                source = audioContext.createMediaElementSource(audioElement);
                source.connect(analyser);
                analyser.connect(audioContext.destination);
                data = new Uint8Array(analyser.frequencyBinCount);
            } catch (error) {
                audioContext = source = analyser = data = null;
                return false;
            }
        }
        if (audioContext.state === "suspended") {
            const resumed = audioContext.resume();
            if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
        }
        return true;
    }

    document.addEventListener("visibilitychange", sync);
    if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", sync);
    else if (reducedMotion.addListener) reducedMotion.addListener(sync);
    if (window.ResizeObserver) {
        const observer = new ResizeObserver(resize);
        observer.observe(spectrumElement);
    } else {
        window.addEventListener("resize", resize);
    }

    return {
        clear,
        prepare,
        resetBars() { peaks = []; },
        resize,
        sync
    };
}
