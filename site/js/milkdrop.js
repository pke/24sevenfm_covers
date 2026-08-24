// A deliberately small MilkDrop-inspired renderer: transformed feedback trails,
// kaleidoscopic radial waveforms and spectrum geometry, without importing the original
// preset language. It is a visualization plugin for audio-spectrum.js and therefore
// shares that module's single AudioContext, analyser read and animation loop.

const MAX_RENDER_WIDTH = 1280;
const MAX_RENDER_HEIGHT = 720;
const PRESET_CROSSFADE_MS = 900;
const AUTO_PRESET_MS = 18000;
const BEAT_HUE_MIN_STEP = 58;
const PRESET_ORDER = ["aurora", "mandala", "tunnel"];

const PRESETS = {
    aurora: {
        symmetry: 5, zoom: 1.012, rotation: .0022, trail: .948, decay: .035,
        radius: .22, amplitude: .15, hueOffset: 8, spokes: 28, drift: .027,
        rings: 3
    },
    mandala: {
        symmetry: 10, zoom: 1.004, rotation: -.0042, trail: .958, decay: .027,
        radius: .27, amplitude: .105, hueOffset: 92, spokes: 50, drift: .012,
        rings: 4
    },
    tunnel: {
        symmetry: 6, zoom: 1.026, rotation: .0013, trail: .925, decay: .052,
        radius: .17, amplitude: .135, hueOffset: 205, spokes: 24, drift: .018,
        rings: 2
    }
};

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function smoothstep(value) {
    const progress = clamp(value, 0, 1);
    return progress * progress * (3 - 2 * progress);
}

function rgbFromElement(element) {
    const channels = getComputedStyle(element).color.match(/[\d.]+/g);
    return channels && channels.length >= 3
        ? channels.slice(0, 3).map(value => Math.round(Number(value)))
        : [130, 92, 255];
}

function rgbHue(rgb) {
    const channels = rgb.map(value => value / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const delta = maximum - minimum;
    if (!delta) return 265;
    let hue = maximum === channels[0]
        ? ((channels[1] - channels[2]) / delta) % 6
        : maximum === channels[1]
            ? (channels[2] - channels[0]) / delta + 2
            : (channels[0] - channels[1]) / delta + 4;
    hue = hue * 60;
    return hue < 0 ? hue + 360 : hue;
}

function hsla(hue, saturation, lightness, alpha) {
    return `hsla(${(hue % 360 + 360) % 360},${saturation}%,${lightness}%,${alpha})`;
}

function hueDelta(from, to) {
    return (to - from + 540) % 360 - 180;
}

function averageBand(data, from, to) {
    const start = Math.max(1, Math.floor(data.length * from));
    const end = Math.max(start + 1, Math.min(data.length, Math.ceil(data.length * to)));
    let total = 0;
    for (let index = start; index < end; index++) total += data[index];
    return total / ((end - start) * 255);
}

function copySurface(source) {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d");
    if (context && copy.width && copy.height) context.drawImage(source, 0, 0);
    return copy;
}

export function createMilkdropVisualization({ canvas, tintElement, facts }) {
    const context = canvas.getContext("2d", { alpha: true });
    const feedbackCanvas = document.createElement("canvas");
    const feedbackContext = feedbackCanvas.getContext("2d", { alpha: true });
    const outgoingCanvas = document.createElement("canvas");
    const outgoingContext = outgoingCanvas.getContext("2d", { alpha: true });
    let presetName = "";
    let previousPreset = "";
    let presetStartedAt = 0;
    let autoStartedAt = 0;
    let transitionStartedAt = -1;
    let bassMean = .12;
    let pulse = 0;
    let lastBeatAt = -10000;
    let beatCount = 0;
    let beatHue = 0;
    let beatHueTarget = 0;
    let frameCount = 0;

    function finishPresetTransition() {
        transitionStartedAt = -1;
        previousPreset = "";
        outgoingCanvas.width = outgoingCanvas.height = 0;
        canvas.dataset.presetTransition = "idle";
        delete canvas.dataset.outgoingPreset;
    }

    function clear() {
        bassMean = .12;
        pulse = 0;
        lastBeatAt = -10000;
        beatCount = 0;
        beatHue = beatHueTarget = 0;
        frameCount = 0;
        presetName = previousPreset = "";
        presetStartedAt = autoStartedAt = 0;
        finishPresetTransition();
        [context, feedbackContext, outgoingContext].forEach((surface, index) => {
            const target = index === 0 ? canvas : index === 1 ? feedbackCanvas : outgoingCanvas;
            if (surface) surface.clearRect(0, 0, target.width, target.height);
        });
        canvas.dataset.frame = "0";
        canvas.dataset.beatCount = "0";
        canvas.dataset.beatPulse = "0";
        canvas.dataset.beatHue = "0";
        canvas.dataset.beatHueTarget = "0";
        delete canvas.dataset.preset;
        delete canvas.dataset.audioSource;
    }

    function resize() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height || !context || !feedbackContext) return false;
        const scale = Math.min(window.devicePixelRatio || 1, 1.5,
            MAX_RENDER_WIDTH / rect.width, MAX_RENDER_HEIGHT / rect.height);
        const width = Math.max(1, Math.round(rect.width * scale));
        const height = Math.max(1, Math.round(rect.height * scale));
        if (canvas.width === width && canvas.height === height) return false;

        const previous = copySurface(canvas);
        canvas.width = feedbackCanvas.width = width;
        canvas.height = feedbackCanvas.height = height;
        if (previous.width && previous.height) {
            context.drawImage(previous, 0, 0, width, height);
            feedbackContext.drawImage(previous, 0, 0, width, height);
        }
        canvas.dataset.renderWidth = String(width);
        canvas.dataset.renderHeight = String(height);
        return true;
    }

    function resolvedPreset(options, timestamp) {
        if (options.milkdropPreset !== "auto") return options.milkdropPreset;
        if (!autoStartedAt) autoStartedAt = timestamp;
        const index = Math.floor((timestamp - autoStartedAt) / AUTO_PRESET_MS)
            % PRESET_ORDER.length;
        return PRESET_ORDER[index];
    }

    function changePreset(nextPreset, timestamp) {
        if (presetName === nextPreset) return;
        if (presetName && outgoingContext && canvas.width && canvas.height) {
            outgoingCanvas.width = canvas.width;
            outgoingCanvas.height = canvas.height;
            outgoingContext.clearRect(0, 0, outgoingCanvas.width, outgoingCanvas.height);
            outgoingContext.drawImage(canvas, 0, 0);
            previousPreset = presetName;
            transitionStartedAt = timestamp;
            canvas.dataset.presetTransition = "crossfading";
            canvas.dataset.outgoingPreset = previousPreset;
        }
        presetName = nextPreset;
        presetStartedAt = timestamp;
        canvas.dataset.preset = nextPreset;
    }

    function updateBeat(frequencyData, timestamp, synthetic) {
        const bass = averageBand(frequencyData, .002, .055);
        const threshold = bassMean * 1.34 + .025;
        if (!synthetic && bass > threshold && bass > .12 && timestamp - lastBeatAt > 240) {
            pulse = 1;
            lastBeatAt = timestamp;
            beatCount++;
            // Walk through the colour wheel by a deliberately large, beat-dependent
            // interval. This makes each kick change the palette instead of merely
            // brightening a continuously drifting hue.
            const step = BEAT_HUE_MIN_STEP + (beatCount % 3) * 29 + bass * 34;
            beatHueTarget = (beatHueTarget + step) % 360;
        } else {
            pulse *= .84;
        }
        beatHue = (beatHue + hueDelta(beatHue, beatHueTarget)
            * (pulse > .35 ? .24 : .09) + 360) % 360;
        bassMean += (bass - bassMean) * (bass > bassMean ? .035 : .012);
        canvas.dataset.beatCount = String(beatCount);
        canvas.dataset.beatPulse = pulse.toFixed(3);
        canvas.dataset.beatHue = beatHue.toFixed(2);
        canvas.dataset.beatHueTarget = beatHueTarget.toFixed(2);
        return bass;
    }

    function drawFeedback(preset, timestamp, width, height) {
        const centerX = width * .5 + Math.sin(timestamp * .00019) * width * preset.drift;
        const centerY = height * .5 + Math.cos(timestamp * .00015) * height * preset.drift;
        context.clearRect(0, 0, width, height);
        if (feedbackCanvas.width) {
            context.save();
            context.globalAlpha = preset.trail;
            context.translate(centerX, centerY);
            context.rotate(preset.rotation * (1 + pulse * 1.8));
            const zoom = preset.zoom + pulse * .006;
            context.scale(zoom, zoom);
            context.translate(-width * .5, -height * .5);
            context.drawImage(feedbackCanvas, 0, 0, width, height);
            context.restore();
        }
        context.fillStyle = `rgba(0,2,10,${preset.decay})`;
        context.fillRect(0, 0, width, height);
        return { x: centerX, y: centerY };
    }

    function drawColorField(preset, timestamp, center, hue, width, height, envelope) {
        const radius = Math.max(width, height) * .72;
        const gradient = context.createRadialGradient(center.x, center.y, 0,
            center.x, center.y, radius);
        gradient.addColorStop(0, hsla(hue + preset.hueOffset + timestamp * .003,
            88, 52 + pulse * 12, (.05 + pulse * .035) * envelope));
        gradient.addColorStop(.46, hsla(hue + preset.hueOffset + 95,
            84, 38, .025 * envelope));
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
    }

    function waveformPoint(timeDomainData, index, sampleCount, symmetry) {
        const phase = index / Math.max(1, sampleCount - 1) * symmetry;
        const section = Math.floor(phase);
        let local = phase - section;
        if (section % 2) local = 1 - local;
        const source = Math.round(local * Math.min(511, timeDomainData.length - 1));
        return (timeDomainData[source] - 128) / 128;
    }

    function drawRadialWaveforms(preset, timestamp, center, hue, timeDomainData,
            bass, envelope, width, height) {
        const shortest = Math.min(width, height);
        const samples = 160;
        const rotation = timestamp * preset.rotation * .017;
        context.save();
        context.globalCompositeOperation = "lighter";
        context.lineJoin = "round";
        context.shadowBlur = Math.max(3, shortest * .012);
        for (let ring = 0; ring < preset.rings; ring++) {
            const ringProgress = preset.rings === 1 ? 0 : ring / (preset.rings - 1);
            const baseRadius = shortest * (preset.radius + ringProgress * .055)
                + pulse * shortest * (.012 + ring * .004);
            const amplitude = shortest * preset.amplitude * (1 - ringProgress * .36)
                * (.54 + bass * .9);
            context.beginPath();
            for (let index = 0; index <= samples; index++) {
                const angle = index / samples * Math.PI * 2 + rotation + ring * .11;
                const sample = waveformPoint(timeDomainData, index, samples + 1,
                    preset.symmetry);
                const radius = baseRadius + sample * amplitude;
                const x = center.x + Math.cos(angle) * radius;
                const y = center.y + Math.sin(angle) * radius;
                if (!index) context.moveTo(x, y);
                else context.lineTo(x, y);
            }
            context.closePath();
            context.lineWidth = Math.max(1, shortest * (.004 - ringProgress * .0015));
            context.strokeStyle = hsla(hue + preset.hueOffset + ring * 42,
                96, 64 + pulse * 15, (.78 - ringProgress * .18) * envelope);
            context.shadowColor = hsla(hue + preset.hueOffset + ring * 42,
                100, 60, .7 * envelope);
            context.stroke();
        }
        context.restore();
    }

    function drawSpectrumGeometry(preset, timestamp, center, hue, frequencyData,
            envelope, width, height) {
        const shortest = Math.min(width, height);
        const baseRadius = shortest * (preset.radius + .08);
        context.save();
        context.globalCompositeOperation = "lighter";
        context.lineCap = "round";
        for (let index = 0; index < preset.spokes; index++) {
            const position = index / preset.spokes;
            const bin = Math.min(frequencyData.length - 1,
                Math.floor(Math.pow(position, 1.55) * frequencyData.length));
            const energy = frequencyData[bin] / 255;
            const angle = position * Math.PI * 2 - timestamp * preset.rotation * .011;
            const inner = baseRadius * (.78 + Math.sin(index * 1.7) * .035);
            const outer = inner + energy * shortest * (.08 + pulse * .035);
            context.beginPath();
            context.moveTo(center.x + Math.cos(angle) * inner,
                center.y + Math.sin(angle) * inner);
            context.lineTo(center.x + Math.cos(angle) * outer,
                center.y + Math.sin(angle) * outer);
            context.lineWidth = Math.max(1, shortest * .0028);
            context.strokeStyle = hsla(hue + preset.hueOffset + position * 150,
                95, 62, (.25 + energy * .62) * envelope);
            context.stroke();
        }

        if (presetName === "tunnel") {
            for (let ring = 0; ring < 8; ring++) {
                const travel = (timestamp * .00009 + ring / 8) % 1;
                const radius = shortest * (.04 + travel * .62);
                context.beginPath();
                context.arc(center.x, center.y, radius, 0, Math.PI * 2);
                context.lineWidth = Math.max(1, shortest * .003 * (1 - travel));
                context.strokeStyle = hsla(hue + preset.hueOffset + ring * 18,
                    92, 58, (1 - travel) * .2 * envelope);
                context.stroke();
            }
        }
        context.restore();
    }

    function commitFeedback(width, height) {
        feedbackContext.clearRect(0, 0, width, height);
        feedbackContext.drawImage(canvas, 0, 0, width, height);
    }

    canvas.dataset.renderer = context && feedbackContext ? "canvas2d-feedback" : "none";
    return {
        id: "milkdrop",
        supportsSyntheticData: true,
        enabled(options) { return !!options.milkdropEnabled; },
        needs: [facts.frequencyData, facts.timeDomainData],
        setActive(active) {
            canvas.classList.toggle("active", active);
            const stage = canvas.closest(".stage");
            if (stage) stage.classList.toggle("milkdrop-scene", active);
        },
        clear,
        draw({ blackboard, envelope, options }) {
            const timestamp = blackboard.get(facts.timestamp);
            const frequencyData = blackboard.get(facts.frequencyData);
            const timeDomainData = blackboard.get(facts.timeDomainData);
            const synthetic = blackboard.get(facts.synthetic);
            if (!context || !feedbackContext || !frequencyData || !frequencyData.length
                    || !timeDomainData || !timeDomainData.length) return;
            resize();
            const nextPreset = resolvedPreset(options, timestamp);
            changePreset(nextPreset, timestamp);
            const preset = PRESETS[presetName] || PRESETS.aurora;
            const width = canvas.width;
            const height = canvas.height;
            const bass = updateBeat(frequencyData, timestamp, synthetic);
            const hue = rgbHue(rgbFromElement(tintElement)) + beatHue;
            const center = drawFeedback(preset, timestamp, width, height);
            drawColorField(preset, timestamp, center, hue, width, height, envelope);
            drawSpectrumGeometry(preset, timestamp, center, hue, frequencyData,
                envelope, width, height);
            drawRadialWaveforms(preset, timestamp, center, hue, timeDomainData,
                bass, envelope, width, height);

            if (transitionStartedAt >= 0 && outgoingCanvas.width) {
                const progress = smoothstep((timestamp - transitionStartedAt)
                    / PRESET_CROSSFADE_MS);
                if (progress >= 1) finishPresetTransition();
                else {
                    context.save();
                    context.globalAlpha = (1 - progress) * envelope;
                    context.drawImage(outgoingCanvas, 0, 0, width, height);
                    context.restore();
                }
            }

            // The controller's envelope owns entrance/exit timing. Multiply the
            // completed frame instead of clearing it early, so outgoing feedback stays
            // rendered for the entire release transition.
            if (envelope < 1) {
                context.save();
                context.globalCompositeOperation = "destination-in";
                context.fillStyle = `rgba(255,255,255,${envelope})`;
                context.fillRect(0, 0, width, height);
                context.restore();
            }
            commitFeedback(width, height);
            canvas.dataset.audioSource = synthetic ? "ambient" : "analyser";
            canvas.dataset.frame = String(++frameCount);
            canvas.dataset.presetAge = String(Math.round(timestamp - presetStartedAt));
        }
    };
}
