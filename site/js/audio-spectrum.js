// Shared Web Audio analyser + small visualization plugins.
//
// The controller owns the media source, reads the analyser once per frame, and writes
// the current facts to a controller-local blackboard shared by enabled visualizations.
// A plugin only needs `enabled`, `draw`, `clear`, and `setActive`; it never creates
// another AudioContext, animation loop, or listener subscription. That keeps future
// station-specific scenes cheap to add while playback remains the one source of truth.

import { createMilkdropVisualization } from "./milkdrop.js";

const ENVELOPE_MS = 400;
export const ANALYSER_FACTS = Object.freeze({
    timestamp: "frame.timestamp",
    frequencyData: "analyser.frequencyData",
    timeDomainData: "analyser.timeDomainData",
    synthetic: "analyser.synthetic",
    tempoAnalysis: "tempo.analysis",
    bpm: "tempo.bpm"
});

function smoothstep(value) {
    const progress = Math.min(1, Math.max(0, value));
    return progress * progress * (3 - 2 * progress);
}

function beatChoreographyFrame(beatCount, beatAge, bpm) {
    const period = bpm ? 60000 / bpm : 500;
    const continuousProgress = Math.max(0, beatAge / period);
    const completedCycles = Math.floor(continuousProgress);
    return {
        from: beatCount + completedCycles % 8,
        to: beatCount + completedCycles % 8 + 1,
        travel: smoothstep(continuousProgress - completedCycles)
    };
}

function strobeEnvelope(timestamp, startedAt, enabled) {
    if (!enabled || startedAt < 0) return 0;
    const age = timestamp - startedAt;
    function flash(start, duration, strength) {
        const progress = (age - start) / duration;
        if (progress <= 0 || progress >= 1) return 0;
        // A fast eased ramp avoids a single hard white frame while preserving the
        // unmistakable double-flash cadence of a club strobe.
        return smoothstep(Math.min(progress * 2, (1 - progress) * 2)) * strength;
    }
    return Math.max(flash(0, 100, 1), flash(145, 110, .72));
}

function smokeEnvelope(timestamp, startedAt, enabled, preview) {
    if (!enabled || startedAt < 0) return 0;
    const age = timestamp - startedAt;
    const duration = preview ? 4800 : 1150;
    const releaseAt = preview ? 1900 : 350;
    if (age <= 0 || age >= duration) return 0;
    const attack = smoothstep(age / 90);
    const release = 1 - smoothstep((age - releaseAt) / (duration - releaseAt));
    return attack * release;
}

function resizeCanvas(canvas, maxScale = 2) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const scale = Math.min(maxScale, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
}

function rgbFromElement(element) {
    const channels = getComputedStyle(element).color.match(/[\d.]+/g);
    return channels && channels.length >= 3
        ? channels.slice(0, 3).map(value => Math.round(Number(value)))
        : [255, 255, 255];
}

function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

// Eight repeatable mirror poses make the rig read as choreography, not noise.
// Pose values are authored like a ceiling fan, then projected down onto the floor;
// coordinates returned here use WebGL Y (zero at the floor).
function laserTargetForBeat(beatCount, index) {
    const lane = (index + .5) / 6;
    const edge = Math.abs(lane - .5);
    const pose = ((beatCount % 8) + 8) % 8;
    let x = lane;
    let y = .82;                                  // straight curtain
    if (pose === 1) {
        x = 1 - lane;                             // crossed curtain
        y = .82;
    } else if (pose === 2) {
        x = .5 + (lane - .5) * .24;              // center pinch
        y = .72 + edge * .34;
    } else if (pose === 3) {
        x = .5 + (lane - .5) * 1.18;             // wide fan
        y = .88 - edge * .2;
    } else if (pose === 4) {
        x = lane;                                 // crown / shallow V
        y = .68 + edge * .48;
    } else if (pose === 5) {
        x = 1 - lane;                             // crossed crown
        y = .68 + edge * .48;
    } else if (pose === 6) {
        x = .5 + (lane - .5) * .4;               // narrow diamond
        y = .9 - edge * .3;
    } else if (pose === 7) {
        x = .5 + (lane - .5) * 1.1;              // wide crown
        y = .72 + edge * .38;
    }
    return {
        x: Math.max(.03, Math.min(.97, x)),
        y: Math.max(.09, Math.min(.44, 1.05 - Math.min(.96, y)))
    };
}

function calmLaserTarget(timestamp, index, bpm) {
    const seconds = timestamp / 1000;
    const offset = index * Math.PI / 3;
    const tempo = bpm ? Math.max(.5, Math.min(1.5, bpm / 120)) : .55;
    return {
        x: .5 + Math.sin(seconds * (.1 + tempo * .11) + offset) * .32,
        y: .27 - Math.cos(seconds * (.075 + tempo * .085) + offset) * .12
    };
}

const ANALYZER_MODE_TRANSITION_MS = 320;

export function createSpectrumVisualization({ canvas, tintElement }) {
    const context = canvas.getContext("2d");
    const outgoingCanvas = document.createElement("canvas");
    const outgoingContext = outgoingCanvas.getContext("2d");
    let peaks = [];
    let renderedSignature = "";
    let renderedType = "";
    let outgoingType = "";
    let transitionStarted = -1;
    let oscilloscopeGain = 1;

    function finishTransition() {
        transitionStarted = -1;
        outgoingType = "";
        outgoingCanvas.width = outgoingCanvas.height = 0;
        canvas.dataset.modeTransition = "idle";
        delete canvas.dataset.outgoingAnalyzer;
    }

    function clear() {
        peaks = [];
        oscilloscopeGain = 1;
        renderedSignature = renderedType = "";
        finishTransition();
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
        delete canvas.dataset.analyzerType;
        delete canvas.dataset.oscilloscopeStyle;
        delete canvas.dataset.oscilloscopeGain;
        delete canvas.dataset.oscilloscopeWindowSamples;
        delete canvas.dataset.timeDomainSamples;
    }

    function beginTransition(timestamp) {
        if (!outgoingContext || !canvas.width || !canvas.height) return;
        outgoingCanvas.width = canvas.width;
        outgoingCanvas.height = canvas.height;
        outgoingContext.clearRect(0, 0, outgoingCanvas.width, outgoingCanvas.height);
        outgoingContext.drawImage(canvas, 0, 0);
        outgoingType = renderedType;
        transitionStarted = timestamp;
        canvas.dataset.modeTransition = "crossfading";
        if (outgoingType) canvas.dataset.outgoingAnalyzer = outgoingType;
    }

    function analyzerSignature(options) {
        return [
            options.analyzerType,
            options.spectrumMode,
            options.spectrumBars,
            options.oscilloscopeStyle
        ].join(":");
    }

    function drawSpectrum(frequencyData, envelope, releasing, options, width, height) {
        const bars = Math.min(options.spectrumBars, frequencyData.length);
        const blockGap = Math.max(1, Math.round(width / 220));
        const gap = width >= bars * 2 + blockGap * (bars - 1) ? blockGap : 0;
        const barWidth = Math.max(1,
            Math.floor((width - gap * (bars - 1)) / bars));
        const plotWidth = barWidth * bars + gap * (bars - 1);
        const plotLeft = Math.max(0, Math.floor((width - plotWidth) * 0.5));
        const usableHeight = height - Math.max(3, Math.round(height * .08));
        const gradient = context.createLinearGradient(0, height, 0, 0);
        let tint = null;
        if (options.spectrumMode === "tinted") {
            tint = rgbFromElement(tintElement);
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
        context.fillStyle = gradient;

        for (let i = 0; i < bars; i++) {
            const position = bars === 1 ? 0 : i / (bars - 1);
            const bin = Math.min(frequencyData.length - 1,
                Math.floor(Math.pow(position, 1.65) * (frequencyData.length - 1)));
            let barHeight = Math.floor(
                (frequencyData[bin] / 255) * usableHeight * envelope);
            const segment = blockGap * 3;
            barHeight = Math.floor(barHeight / segment) * segment;
            const x = plotLeft + Math.round(i * (barWidth + gap));
            context.fillRect(x, height - barHeight, barWidth, barHeight);
            const peak = peaks[i] || 0;
            peaks[i] = releasing
                ? Math.min(peak || barHeight, barHeight)
                : barHeight >= peak
                    ? barHeight : Math.max(0, peak - Math.max(1, height * .06));
        }

        // Horizontal cuts give the compact analyzer its blocky Winamp texture.
        for (let y = height - blockGap * 2; y > 0; y -= blockGap * 3)
            context.clearRect(0, y, width, blockGap);
        for (let i = 0; i < bars; i++) {
            const peakHeight = peaks[i];
            if (peakHeight <= 0) continue;
            const ratio = peakHeight / usableHeight;
            context.fillStyle = tint
                ? rgba(tint, Math.min(1, .45 + ratio * .55))
                : ratio > .8 ? "#ff6269" : ratio > .58 ? "#ffe163" : "#8aff79";
            context.fillRect(plotLeft + Math.round(i * (barWidth + gap)),
                Math.max(0, height - peakHeight - blockGap), barWidth, blockGap);
        }
    }

    function drawOscilloscope(timeDomainData, envelope, options, width, height) {
        if (!timeDomainData || !timeDomainData.length) return;
        const tint = options.spectrumMode === "tinted"
            ? rgbFromElement(tintElement) : [54, 237, 100];
        const center = height * .5;
        // A full 1024-sample buffer is visually cramped in this wide, shallow strip.
        // Winamp's scope read more clearly because it showed a shorter instant of the
        // waveform. Keep the analyser resolution for beat plugins, but draw only the
        // leading half here and derive automatic gain from its RMS energy.
        const windowSamples = Math.min(512, timeDomainData.length);
        let sumSquares = 0;
        for (let index = 0; index < windowSamples; index++) {
            const sample = timeDomainData[index] - 128;
            sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, windowSamples));
        const targetGain = Math.min(7, Math.max(1, 42 / Math.max(1, rms)));
        oscilloscopeGain += (targetGain - oscilloscopeGain)
            * (targetGain < oscilloscopeGain ? .24 : .07);
        const amplitude = height * .44 * envelope * oscilloscopeGain;
        const denseSampleCount = Math.max(64, Math.floor(width * .5));
        const dotSampleCount = Math.max(24, Math.min(48, Math.floor(width / 12)));
        const sampleCount = Math.min(windowSamples,
            options.oscilloscopeStyle === "dots" ? dotSampleCount : denseSampleCount);
        const sourceStep = (windowSamples - 1) / Math.max(1, sampleCount - 1);
        const xStep = width / Math.max(1, sampleCount - 1);
        const lineWidth = Math.max(1, Math.round(height * .026));
        const point = index => ({
            x: index * xStep,
            y: Math.max(lineWidth, Math.min(height - lineWidth,
                center + ((timeDomainData[Math.round(index * sourceStep)] - 128) / 128)
                    * amplitude))
        });

        context.lineWidth = lineWidth;
        context.lineJoin = "round";
        context.lineCap = options.oscilloscopeStyle === "dots" ? "butt" : "round";
        context.strokeStyle = rgba(tint, 1);
        context.fillStyle = rgba(tint, 1);

        if (options.oscilloscopeStyle === "dots") {
            const radius = Math.max(2, height * .038);
            context.beginPath();
            for (let index = 0; index < sampleCount; index++) {
                const current = point(index);
                context.moveTo(current.x + radius, current.y);
                context.arc(current.x, current.y, radius, 0, Math.PI * 2);
            }
            context.fill();
            return;
        }

        context.beginPath();
        if (options.oscilloscopeStyle === "filled") context.moveTo(0, center);
        for (let index = 0; index < sampleCount; index++) {
            const current = point(index);
            if (index === 0 && options.oscilloscopeStyle !== "filled")
                context.moveTo(current.x, current.y);
            else context.lineTo(current.x, current.y);
        }
        if (options.oscilloscopeStyle === "filled") {
            context.lineTo(width, center);
            context.closePath();
            context.fillStyle = rgba(tint, .62);
            context.fill();
        }
        context.stroke();
    }

    return {
        id: "spectrum",
        enabled(options) { return !!options.spectrumEnabled; },
        needs(options) {
            return options.analyzerType === "oscilloscope"
                ? [ANALYSER_FACTS.frequencyData, ANALYSER_FACTS.timeDomainData]
                : [ANALYSER_FACTS.frequencyData];
        },
        setActive(active) { canvas.classList.toggle("active", active); },
        clear,
        reset() { peaks = []; },
        draw({ blackboard, envelope, releasing, options }) {
            const timestamp = blackboard.get(ANALYSER_FACTS.timestamp);
            const frequencyData = blackboard.get(ANALYSER_FACTS.frequencyData);
            const timeDomainData = blackboard.get(ANALYSER_FACTS.timeDomainData);
            if (!context || !frequencyData || !frequencyData.length) return;
            const type = options.analyzerType === "oscilloscope"
                ? "oscilloscope" : "spectrum";
            const signature = analyzerSignature(options);
            // Capture the old pixels before resizeCanvas changes the backing-store
            // dimensions (which clears it). Mode changes intentionally animate the
            // canvas height, so the retained outgoing frame must survive that resize.
            if (renderedSignature && renderedSignature !== signature) beginTransition(timestamp);
            if (resizeCanvas(canvas)) peaks = [];
            if (renderedType && renderedType !== type) peaks = [];
            renderedSignature = signature;
            renderedType = type;

            let progress = 1;
            if (transitionStarted >= 0) {
                progress = smoothstep((timestamp - transitionStarted)
                    / ANALYZER_MODE_TRANSITION_MS);
                if (progress >= 1) finishTransition();
            }

            const width = canvas.width;
            const height = canvas.height;
            context.clearRect(0, 0, width, height);
            context.save();
            context.globalAlpha = progress;
            if (type === "oscilloscope")
                drawOscilloscope(timeDomainData, envelope, options, width, height);
            else drawSpectrum(frequencyData, envelope, releasing, options, width, height);
            context.restore();

            if (transitionStarted >= 0 && outgoingCanvas.width) {
                context.save();
                context.globalAlpha = (1 - progress) * envelope;
                context.drawImage(outgoingCanvas, 0, 0, width, height);
                context.restore();
            }

            canvas.dataset.analyzerType = type;
            if (type === "oscilloscope") {
                canvas.dataset.oscilloscopeStyle = options.oscilloscopeStyle;
                canvas.dataset.oscilloscopeGain = oscilloscopeGain.toFixed(2);
                canvas.dataset.oscilloscopeWindowSamples = String(Math.min(512,
                    timeDomainData ? timeDomainData.length : 0));
                canvas.dataset.timeDomainSamples = String(timeDomainData
                    ? timeDomainData.length : 0);
            } else {
                delete canvas.dataset.oscilloscopeStyle;
                delete canvas.dataset.oscilloscopeGain;
                delete canvas.dataset.oscilloscopeWindowSamples;
                delete canvas.dataset.timeDomainSamples;
            }
            if (transitionStarted < 0) canvas.dataset.modeTransition = "idle";
        }
    };
}

function createLaserWebGlRenderer(canvas) {
    const gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        depth: false,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
        powerPreference: "high-performance"
    });
    if (!gl) return null;
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererName = String(rendererInfo
        ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER));
    const softwareWebGl = /swiftshader|llvmpipe|software|warp|basic render/i
        .test(rendererName);
    const fragmentBudget = softwareWebGl ? 180000 : 600000;
    const maximumScale = softwareWebGl ? .35 : 1.5;
    canvas.dataset.gpuTier = softwareWebGl ? "software" : "hardware";

    const vertexSource = `
        attribute vec2 a_position;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
        }
    `;
    const fragmentSource = `
        precision mediump float;
        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_bass;
        uniform float u_mids;
        uniform float u_highs;
        uniform float u_beat;
        uniform float u_beat_count;
        uniform float u_beat_age;
        uniform float u_envelope;
        uniform float u_drive;
        uniform float u_tempo;
        uniform sampler2D u_spectrum;
        uniform vec2 u_beam_target0;
        uniform vec2 u_beam_target1;
        uniform vec2 u_beam_target2;
        uniform vec2 u_beam_target3;
        uniform vec2 u_beam_target4;
        uniform vec2 u_beam_target5;

        float segmentDistanceSquared(vec2 point, vec2 start, vec2 end) {
            vec2 line = end - start;
            float projection = clamp(dot(point - start, line)
                / max(dot(line, line), 0.0001), 0.0, 1.0);
            vec2 delta = point - start - line * projection;
            return dot(delta, delta);
        }
        vec3 laserColor(float index) {
            if (index < 0.5) return vec3(0.0, 1.0, 1.0);
            if (index < 1.5) return vec3(1.0, 0.0, 0.68);
            if (index < 2.5) return vec3(0.48, 1.0, 0.0);
            if (index < 3.5) return vec3(0.58, 0.05, 1.0);
            if (index < 4.5) return vec3(0.05, 0.28, 1.0);
            return vec3(1.0, 0.05, 0.16);
        }
        vec2 beamTarget(int index) {
            if (index == 0) return u_beam_target0;
            if (index == 1) return u_beam_target1;
            if (index == 2) return u_beam_target2;
            if (index == 3) return u_beam_target3;
            if (index == 4) return u_beam_target4;
            return u_beam_target5;
        }
        float cheapGlow(float distanceSquared, float width) {
            // mediump fragment floats can flush tiny squared beam widths to zero.
            // Scale both sides of the ratio first: the result is identical, while
            // 0/0 NaNs can no longer black out the complete fragment.
            float scaledWidth = width * 32.0;
            float widthSquared = scaledWidth * scaledWidth;
            float scaledDistanceSquared = distanceSquared * 1024.0;
            float glow = widthSquared / (widthSquared + scaledDistanceSquared);
            return glow * glow;
        }
        float neonLine(float distanceSquared, float coreWidth, float glowWidth) {
            float scaledCoreWidth = coreWidth * 32.0;
            float core = 1.0 - smoothstep(0.0,
                scaledCoreWidth * scaledCoreWidth, distanceSquared * 1024.0);
            float glow = cheapGlow(distanceSquared, glowWidth);
            return core * 2.4 + glow * 0.72;
        }
        void main() {
            vec2 uv = gl_FragCoord.xy / u_resolution.xy;
            float aspect = u_resolution.x / u_resolution.y;
            vec2 point = vec2((uv.x - 0.5) * aspect, uv.y);
            float time = u_time;
            vec3 light = vec3(0.0);

            // The floor deliberately uses a sparse grid. Squared-distance rational
            // glows approximate bloom without transcendental math in every fragment.
            // Keep the room and spectrum wall architecturally still. The music moves
            // the lights and bar heights, never the back wall itself.
            float horizon = 0.43;
            if (uv.y < horizon) {
                float floorY = uv.y / horizon;
                float depth = 0.92 / max(0.075, 1.04 - floorY);
                float floorSpeed = mix(0.09,
                    0.22 + u_tempo * 0.2 + u_bass * 0.42, u_drive);
                float horizontalCell = fract(depth * 0.72 - time * floorSpeed);
                float horizontalDelta = horizontalCell - 0.5;
                float horizontal = neonLine(horizontalDelta * horizontalDelta,
                    0.018, 0.065);
                float centerDistance = (uv.x - 0.5) / max(0.08, 1.03 - floorY);
                float verticalCell = fract(centerDistance * 4.5 + 0.5) - 0.5;
                float vertical = neonLine(verticalCell * verticalCell, 0.02, 0.07);
                float tile = floor(depth * 0.72) + floor(centerDistance * 4.5);
                vec3 gridColor = mix(vec3(0.02, 0.75, 1.0), vec3(1.0, 0.0, 0.72),
                    step(0.5, fract(tile * 0.5)));
                float tilePulse = (0.04 + u_bass * 0.16 + u_beat * u_drive * 0.7)
                    * step(0.5, fract((tile + u_beat_count) * 0.5));
                float rearFade = 1.0 - smoothstep(0.7, 0.95, floorY);
                light += gridColor * (horizontal + vertical)
                    * mix(0.075, 0.18 + u_bass * 0.42, u_drive) * rearFade;
                light += gridColor * tilePulse * (1.0 - floorY)
                    * 0.5 * u_drive * rearFade;
            }

            // The far wall is a real 32-band FFT texture, not a decorative equalizer.
            // Block gaps evoke period LED displays while the shader supplies bloom.
            vec2 wallUv = vec2((uv.x - 0.12) / 0.76,
                (uv.y - horizon - 0.025) / 0.29);
            if (wallUv.x >= 0.0 && wallUv.x <= 1.0
                    && wallUv.y >= 0.0 && wallUv.y <= 1.0) {
                float bandIndex = floor(min(wallUv.x, 0.999) * 32.0);
                float bandValue = texture2D(u_spectrum,
                    vec2((bandIndex + 0.5) / 32.0, 0.5)).r;
                float barCell = fract(wallUv.x * 32.0);
                float barMask = smoothstep(0.08, 0.2, barCell)
                    * (1.0 - smoothstep(0.8, 0.92, barCell));
                float segmentMask = smoothstep(0.08, 0.24, fract(wallUv.y * 12.0));
                float barLit = step(wallUv.y, bandValue * 0.94)
                    * barMask * segmentMask;
                vec3 wallColor = mix(vec3(0.0, 1.0, 1.0), vec3(1.0, 0.0, 0.62),
                    smoothstep(0.22, 0.9, wallUv.y));
                light += wallColor * barLit * (1.25 + u_beat * u_drive * 0.8);
                float wallBorder = step(wallUv.x, 0.012) + step(0.988, wallUv.x)
                    + step(wallUv.y, 0.018) + step(0.982, wallUv.y);
                light += vec3(0.35, 0.02, 0.8) * wallBorder * (0.75 + u_mids);
            }

            // Target hashing and mirror motion are calculated once per beam on the
            // CPU, not six times for every pixel in this shader.
            for (int beam = 0; beam < 6; beam++) {
                float index = float(beam);
                float originX = mix(-aspect * 0.48, aspect * 0.48, (index + 0.5) / 6.0);
                vec2 origin = vec2(originX, 0.965 - mod(index, 2.0) * 0.025);
                vec2 target = beamTarget(beam);
                float distanceToBeam = segmentDistanceSquared(point, origin, target);
                float beamPulse = u_beat * u_drive;
                float coreWidth = 0.0012 + u_highs * 0.0012
                    + beamPulse * 0.0015;
                float glowWidth = 0.012 + u_bass * 0.012 + beamPulse * 0.02;
                float intensity = mix(0.11 + u_highs * 0.16,
                    0.28 + u_mids * 0.82, u_drive) + beamPulse * 1.45;
                light += laserColor(index) * neonLine(distanceToBeam,
                    coreWidth, glowWidth) * intensity;
                // A separate, low-energy halo makes the complete beam breathe on the
                // kick. It is pulse-only, so it cannot turn the black room into fog.
                light += laserColor(index) * cheapGlow(distanceToBeam,
                    0.022 + beamPulse * 0.026) * beamPulse * 0.62;

                // The beam terminates in a compressed pool of light on the floor.
                // Without this footprint the round segment cap reads as if the ray
                // continued through the stage.
                vec2 landingDelta = point - target;
                landingDelta.y *= 2.7;
                float landingDistance = dot(landingDelta, landingDelta);
                float landingHalo = cheapGlow(landingDistance,
                    0.018 + beamPulse * 0.009);
                float landingCore = cheapGlow(landingDistance,
                    0.005 + beamPulse * 0.003);
                light += laserColor(index) * landingHalo
                    * (0.3 + intensity * 0.22 + beamPulse * 0.38);
                // Put the large projector-like energy peak where the ray hits the
                // stage, rather than leaving the brightest blobs on the ceiling.
                light += laserColor(index) * cheapGlow(landingDistance,
                    0.014 + beamPulse * 0.009)
                    * (0.48 + u_drive * 0.72 + beamPulse * 2.0);
                light += vec3(1.0) * landingCore
                    * (0.18 + beamPulse * 0.42);

                // A small emitter remains visible, but the large glow lives at impact.
                vec2 emitterDelta = point - origin;
                light += laserColor(index) * cheapGlow(dot(emitterDelta, emitterDelta), 0.006)
                    * (0.18 + u_drive * 0.2 + beamPulse * 0.24);
            }

            // A beat shockwave and radial diffraction spikes sell the club-light hit
            // without flashing the entire screen.
            vec2 burstPoint = point - vec2(0.0, 0.55);
            float burstRadius = u_beat_age * (0.9 + u_bass * 0.4);
            float burstDistance = dot(burstPoint, burstPoint);
            float ringDelta = abs(burstDistance - burstRadius * burstRadius);
            float ring = (1.0 - smoothstep(0.0, 0.012 + burstRadius * 0.025, ringDelta))
                * u_beat * u_drive * (1.0 - smoothstep(0.0, 0.85, burstRadius));
            float axial = min(abs(burstPoint.x), abs(burstPoint.y));
            float diagonal = min(abs(burstPoint.x - burstPoint.y),
                abs(burstPoint.x + burstPoint.y)) * 0.707;
            float diffraction = (cheapGlow(axial * axial, 0.004)
                + cheapGlow(diagonal * diagonal, 0.003))
                * (1.0 / (1.0 + burstDistance * 12.0)) * u_beat * u_drive;
            light += vec3(0.15, 0.75, 1.0) * ring * 1.7;
            light += vec3(1.0, 0.02, 0.65) * diffraction * 0.72;

            // Four fixed ceiling emitters are enough to suggest sparkle without a
            // second per-pixel loop or time-based trigonometry.
            vec2 star0 = point - vec2(-aspect * 0.38, 0.82);
            vec2 star1 = point - vec2(-aspect * 0.12, 0.91);
            vec2 star2 = point - vec2(aspect * 0.17, 0.86);
            vec2 star3 = point - vec2(aspect * 0.41, 0.94);
            float sparkle = u_highs * mix(0.25, 1.0, u_drive);
            light += vec3(0.0, 1.0, 1.0) * cheapGlow(dot(star0, star0), 0.007) * sparkle;
            light += vec3(1.0, 0.0, 0.68) * cheapGlow(dot(star1, star1), 0.006) * sparkle;
            light += vec3(0.48, 1.0, 0.0) * cheapGlow(dot(star2, star2), 0.007) * sparkle;
            light += vec3(0.58, 0.05, 1.0) * cheapGlow(dot(star3, star3), 0.006) * sparkle;

            // A restrained CRT cadence without a fog layer over the dance floor.
            light *= 0.94 + 0.06 * step(0.5, fract(gl_FragCoord.y * 0.5));
            light *= u_envelope;
            vec3 mapped = (light * 1.15) / (vec3(1.0) + light * 1.15);
            float alpha = clamp(max(max(mapped.r, mapped.g), mapped.b) * 0.88, 0.0, 0.92);
            gl_FragColor = vec4(mapped, alpha);
        }
    `;

    function shader(type, source) {
        const value = gl.createShader(type);
        gl.shaderSource(value, source);
        gl.compileShader(value);
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
            gl.deleteShader(value);
            return null;
        }
        return value;
    }

    const vertexShader = shader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = shader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    const uniforms = {};
    ["resolution", "time", "bass", "mids", "highs", "beat", "beat_count",
        "beat_age", "envelope", "drive", "tempo"].forEach(name => {
        uniforms[name] = gl.getUniformLocation(program, "u_" + name);
    });
    uniforms.spectrum = gl.getUniformLocation(program, "u_spectrum");
    uniforms.beamTargets = Array.from({ length: 6 }, (_, index) =>
        gl.getUniformLocation(program, "u_beam_target" + index));
    const spectrumTexture = gl.createTexture();
    const spectrumPixels = new Uint8Array(32);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, spectrumTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 32, 1, 0,
        gl.LUMINANCE, gl.UNSIGNED_BYTE, spectrumPixels);

    function clear() {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    return {
        type: "webgl",
        gpuTier: softwareWebGl ? "software" : "hardware",
        clear,
        draw({ timestamp, bass, mids, highs, beat, beatCount, beatAge, envelope,
            drive, bpm, spectrumBands }) {
            // Keep the fragment count bounded on large/HiDPI stages, while normal
            // embedded players can reach device resolution when they fit the budget.
            const rect = canvas.getBoundingClientRect();
            const pixelBudgetScale = rect.width && rect.height
                ? Math.sqrt(fragmentBudget / (rect.width * rect.height)) : maximumScale;
            resizeCanvas(canvas, Math.max(.16, Math.min(maximumScale, pixelBudgetScale)));
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program);
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            gl.enableVertexAttribArray(position);
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
            gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
            gl.uniform1f(uniforms.time, timestamp / 1000);
            gl.uniform1f(uniforms.bass, bass);
            gl.uniform1f(uniforms.mids, mids);
            gl.uniform1f(uniforms.highs, highs);
            gl.uniform1f(uniforms.beat, beat);
            gl.uniform1f(uniforms.beat_count, beatCount);
            gl.uniform1f(uniforms.beat_age, beatAge / 1000);
            gl.uniform1f(uniforms.envelope, envelope);
            gl.uniform1f(uniforms.drive, drive);
            gl.uniform1f(uniforms.tempo, bpm ? Math.max(.5, Math.min(1.5, bpm / 120)) : .55);
            // Use the complete beat interval: reaching the pose early introduced a
            // visible hold before every kick. Predicted cycles continue if an onset
            // arrives late, so a still-rhythmic section never leaves the rig parked.
            const choreography = beatChoreographyFrame(beatCount, beatAge, bpm);
            const aspect = canvas.width / canvas.height;
            for (let index = 0; index < uniforms.beamTargets.length; index++) {
                const oldTarget = laserTargetForBeat(choreography.from, index);
                const newTarget = laserTargetForBeat(choreography.to, index);
                const calmTarget = calmLaserTarget(timestamp, index, bpm);
                const beatX = oldTarget.x
                    + (newTarget.x - oldTarget.x) * choreography.travel;
                const beatY = oldTarget.y
                    + (newTarget.y - oldTarget.y) * choreography.travel;
                gl.uniform2f(uniforms.beamTargets[index],
                    ((calmTarget.x + (beatX - calmTarget.x) * drive) - .5)
                        * aspect * 1.18,
                    calmTarget.y + (beatY - calmTarget.y) * drive);
            }
            for (let index = 0; index < spectrumPixels.length; index++)
                spectrumPixels[index] = Math.round(spectrumBands[index] * 255);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, spectrumTexture);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 1,
                gl.LUMINANCE, gl.UNSIGNED_BYTE, spectrumPixels);
            gl.uniform1i(uniforms.spectrum, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
    };
}

const LASER_COLORS = ["#00ffff", "#ff00ad", "#7aff00", "#940dff", "#0d47ff", "#ff0d29"];

function drawCanvasBeam(context, x1, y1, x2, y2, color, strength, pulse,
        opacity = 1) {
    context.save();
    context.globalCompositeOperation = "screen";
    context.strokeStyle = color;
    context.lineCap = "round";
    context.shadowColor = color;
    context.shadowBlur = 22 + strength * 28 + pulse * 38;
    context.globalAlpha = Math.min(1, (.1 + strength * .18 + pulse * .2) * opacity);
    context.lineWidth = 8 + strength * 12 + pulse * 20;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
    context.globalAlpha = Math.min(1, (.65 + strength * .35) * opacity);
    context.shadowBlur = 9 + strength * 14 + pulse * 12;
    context.lineWidth = 1.25 + strength * 2 + pulse * 1.5;
    context.stroke();
    context.restore();
}

function drawCanvasLandingSpot(context, x, y, color, strength, pulse, unit,
        opacity = 1) {
    const radius = unit * (.012 + strength * .005 + pulse * .006);
    context.save();
    context.translate(x, y);
    context.globalCompositeOperation = "screen";
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 12 + strength * 16 + pulse * 18;
    context.globalAlpha = Math.min(1, (.38 + strength * .28 + pulse * .2) * opacity);
    context.beginPath();
    context.ellipse(0, 0, radius, radius * .3, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.shadowBlur = 5 + pulse * 8;
    context.globalAlpha = Math.min(1, (.3 + pulse * .34) * opacity);
    context.beginPath();
    context.ellipse(0, 0, radius * .28, radius * .12, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
}

function createSmokeParticleSprite(dense) {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 96;
    const context = sprite.getContext("2d");
    if (!context) return sprite;
    const lobes = dense
        ? [[48, 48, 25, .72], [35, 50, 19, .44], [59, 42, 18, .38]]
        : [[47, 49, 28, .42], [29, 50, 22, .29], [65, 47, 21, .27],
            [40, 31, 20, .25], [55, 66, 23, .24], [27, 67, 16, .17]];
    for (const [x, y, radius, opacity] of lobes) {
        const gradient = context.createRadialGradient(x, y, 1, x, y, radius);
        gradient.addColorStop(0, `rgba(248,253,255,${opacity})`);
        gradient.addColorStop(.42, `rgba(225,245,250,${opacity * .62})`);
        gradient.addColorStop(1, "rgba(190,225,235,0)");
        context.fillStyle = gradient;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    return sprite;
}

function createSmokeParticleMachine(hardwareAccelerated) {
    const softSprite = createSmokeParticleSprite(false);
    const denseSprite = createSmokeParticleSprite(true);
    const particles = [];
    let burstId = 0;

    // A tiny repeatable PRNG makes a burst organic without moving particles to a
    // different random position on every frame.
    function randomGenerator(seed) {
        let state = (seed ^ 0x9e3779b9) >>> 0;
        return function random() {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 4294967296;
        };
    }

    function emit(id, preview) {
        particles.length = 0;
        burstId = id;
        const random = randomGenerator(id * 977 + (preview ? 37 : 11));
        // The foreground pass has a deliberately small pixel budget, so a few
        // hundred cached sprites are enough for a dense blast even on integrated GPUs.
        const perSide = hardwareAccelerated
            ? (preview ? 94 : 62) : (preview ? 70 : 48);
        for (const side of [-1, 1]) {
            for (let index = 0; index < perSide; index++) {
                const dense = random() < .15;
                particles.push({
                    side,
                    dense,
                    delay: random() * (preview ? .72 : .36),
                    life: dense
                        ? (preview ? .7 + random() * .55 : .55 + random() * .4)
                        : (preview ? 2.15 + random() * 1.9 : 1.35 + random() * 1.25),
                    speedX: (dense ? .46 : .24) + random() * (dense ? .24 : .28),
                    speedY: -(dense ? .1 : .035) - random() * (dense ? .2 : .16),
                    drag: .48 + random() * .66,
                    buoyancy: .035 + random() * (dense ? .035 : .075),
                    nozzleX: (random() - .5) * .018,
                    nozzleY: (random() - .5) * .065,
                    radius: (dense ? .003 : .009) + random() * (dense ? .004 : .013),
                    growth: (dense ? .004 : .034) + random() * (dense ? .007 : .048),
                    turbulence: .006 + random() * .025,
                    phase: random() * Math.PI * 2,
                    alpha: (dense ? .42 : .15) + random() * (dense ? .26 : .2)
                });
            }
        }
    }

    return {
        clear() {
            particles.length = 0;
            burstId = 0;
        },
        draw(context, width, height, frame) {
            if (!frame.smokeEnabled || frame.smokeBurstId <= 0) {
                this.clear();
                return 0;
            }
            if (frame.smokeBurstId !== burstId)
                emit(frame.smokeBurstId, frame.smokePreview);

            const unit = Math.min(width, height);
            let liveParticles = 0;
            context.save();
            context.globalCompositeOperation = "screen";
            for (const particle of particles) {
                const age = frame.smokeAge - particle.delay;
                if (age < 0 || age >= particle.life) continue;
                liveParticles++;
                const progress = age / particle.life;
                const travel = (1 - Math.exp(-particle.drag * age)) / particle.drag;
                const direction = particle.side < 0 ? 1 : -1;
                const originX = width * (particle.side < 0 ? .012 : .988)
                    + width * particle.nozzleX;
                const originY = height * (.91 + particle.nozzleY);
                const turbulence = Math.sin(age * 8 + particle.phase)
                    * unit * particle.turbulence * smoothstep(progress * 2.4);
                const x = originX + direction * width * particle.speedX * travel
                    + turbulence * Math.sin(particle.phase);
                // Horizontal nozzle momentum decays with drag; buoyancy keeps pulling
                // the slower expanding cloud upward instead of letting it sag.
                const y = originY + height * (particle.speedY * travel
                    - particle.buoyancy * age * age)
                    + turbulence * Math.cos(particle.phase);
                const radius = unit * (particle.radius + particle.growth
                    * smoothstep(progress));
                const attack = smoothstep(age / .07);
                const release = 1 - smoothstep((progress - .48) / .52);
                const alpha = particle.alpha * attack * release;
                if (alpha <= .002) continue;

                context.globalAlpha = alpha;
                if (particle.dense) {
                    // Young high-speed particles stretch along the nozzle direction;
                    // after losing velocity they round off into the surrounding cloud.
                    const stretch = 1.05 + (1 - progress) * .8;
                    context.save();
                    context.translate(x, y);
                    context.rotate(particle.side < 0 ? -.48 : Math.PI + .48);
                    context.drawImage(denseSprite, -radius * stretch, -radius,
                        radius * 2 * stretch, radius * 2);
                    context.restore();
                } else {
                    const squash = .82 + Math.sin(particle.phase) * .12;
                    context.drawImage(softSprite, x - radius * 1.15, y - radius * squash,
                        radius * 2.3, radius * 2 * squash);
                }
            }
            context.restore();
            return liveParticles;
        }
    };
}

function createLaserCanvasRenderer(canvas) {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const colors = LASER_COLORS;

    return {
        type: "canvas",
        clear() { context.clearRect(0, 0, canvas.width, canvas.height); },
        draw({ timestamp, bass, mids, highs, beat, beatCount, beatAge, envelope,
            drive, bpm, spectrumBands }) {
            const rect = canvas.getBoundingClientRect();
            const pixelBudgetScale = rect.width && rect.height
                ? Math.sqrt(450000 / (rect.width * rect.height)) : .8;
            resizeCanvas(canvas, Math.max(.25, Math.min(.8, pixelBudgetScale)));
            const width = canvas.width;
            const height = canvas.height;
            context.clearRect(0, 0, width, height);
            const horizon = height * (.57 - bass * .035);
            const wallLeft = width * .12;
            const wallWidth = width * .76;
            const wallHeight = height * .29;
            context.save();
            context.globalCompositeOperation = "screen";
            const gradient = context.createLinearGradient(0, horizon, 0, horizon - wallHeight);
            gradient.addColorStop(0, colors[0]);
            gradient.addColorStop(.62, colors[3]);
            gradient.addColorStop(1, colors[1]);
            context.fillStyle = gradient;
            for (let index = 0; index < spectrumBands.length; index++) {
                const cellWidth = wallWidth / spectrumBands.length;
                const barHeight = spectrumBands[index] * wallHeight * .94;
                context.shadowColor = index % 2 ? colors[0] : colors[1];
                context.shadowBlur = 8 + beat * drive * 14;
                for (let y = 0; y < barHeight; y += 7) {
                    context.globalAlpha = (.62 + beat * drive * .3) * envelope;
                    context.fillRect(wallLeft + index * cellWidth + cellWidth * .14,
                        horizon - y - 5, cellWidth * .72, 4);
                }
            }
            context.restore();
            context.save();
            context.globalCompositeOperation = "screen";
            context.globalAlpha = (.07 + drive * .11 + bass * drive * .32
                + beat * drive * .35) * envelope;
            context.shadowBlur = 10;
            const tempo = bpm ? Math.max(.5, Math.min(1.5, bpm / 120)) : .55;
            for (let row = 0; row < 7; row++) {
                const phase = (row / 7 + timestamp * .00009
                    * (1 + drive * tempo + bass * drive)) % 1;
                const y = horizon + phase * phase * (height - horizon);
                context.globalAlpha = (.07 + drive * .11 + bass * drive * .32
                    + beat * drive * .35) * envelope * smoothstep(phase / .28);
                context.strokeStyle = row % 2 ? colors[0] : colors[1];
                context.shadowColor = context.strokeStyle;
                context.beginPath();
                context.moveTo(0, y);
                context.lineTo(width, y);
                context.stroke();
            }
            for (let column = -5; column <= 5; column++) {
                const floorStart = .08;
                const endX = width * (.5 + column * .115);
                context.strokeStyle = column % 2 ? colors[0] : colors[1];
                context.beginPath();
                context.moveTo(width * .5 + (endX - width * .5) * floorStart,
                    horizon + (height - horizon) * floorStart);
                context.lineTo(endX, height);
                context.stroke();
            }
            context.restore();
            const choreography = beatChoreographyFrame(beatCount, beatAge, bpm);
            for (let index = 0; index < 6; index++) {
                const oldTarget = laserTargetForBeat(choreography.from, index);
                const newTarget = laserTargetForBeat(choreography.to, index);
                const calmTarget = calmLaserTarget(timestamp, index, bpm);
                const beatX = oldTarget.x
                    + (newTarget.x - oldTarget.x) * choreography.travel;
                const beatY = oldTarget.y
                    + (newTarget.y - oldTarget.y) * choreography.travel;
                const targetX = width * (calmTarget.x + (beatX - calmTarget.x) * drive);
                const targetY = height * (1 - calmTarget.y - (beatY - calmTarget.y) * drive);
                const calmStrength = .12 + highs * .15;
                const activeStrength = mids * .7 + highs * .35;
                const strength = Math.min(1, (calmStrength
                    + (activeStrength - calmStrength) * drive + beat * drive) * envelope);
                drawCanvasBeam(context, width * ((index + .5) / 6),
                    height * (.04 + (index % 2) * .025),
                    targetX, targetY, colors[index], strength, beat * drive * envelope);
                drawCanvasLandingSpot(context, targetX, targetY, colors[index],
                    strength, beat * drive * envelope, Math.min(width, height), envelope);
            }
        }
    };
}

function createLaserForegroundRenderer(canvas, webglCoordinates, hardwareWebGl) {
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    let paintedFrames = 0;
    let strobePaintedFrames = 0;
    let smokePaintedFrames = 0;
    const smokeParticles = createSmokeParticleMachine(hardwareWebGl);

    function clear() {
        context.clearRect(0, 0, canvas.width, canvas.height);
        paintedFrames = 0;
        strobePaintedFrames = 0;
        smokePaintedFrames = 0;
        smokeParticles.clear();
        canvas.dataset.frontBeams = "0";
        canvas.dataset.frontPaintedFrames = "0";
        canvas.dataset.strobePaintedFrames = "0";
        canvas.dataset.strobeLevel = "0";
        canvas.dataset.smokePaintedFrames = "0";
        canvas.dataset.smokeLevel = "0";
        canvas.dataset.smokeParticles = "0";
    }

    return {
        clear,
        draw({ timestamp, mids, highs, beat, beatCount, beatAge, envelope,
            drive, bpm, strobe, smoke, smokeAge, smokeEnabled, smokePreview,
            smokeBurstId }) {
            const rect = canvas.getBoundingClientRect();
            const pixelBudget = hardwareWebGl ? 600000 : 280000;
            const maximumScale = hardwareWebGl ? 1.5 : .75;
            const pixelBudgetScale = rect.width && rect.height
                ? Math.sqrt(pixelBudget / (rect.width * rect.height)) : maximumScale;
            resizeCanvas(canvas, Math.max(.25,
                Math.min(maximumScale, pixelBudgetScale)));
            const width = canvas.width;
            const height = canvas.height;
            context.clearRect(0, 0, width, height);
            const choreography = beatChoreographyFrame(beatCount, beatAge, bpm);
            // Fade the foreground pass in and out inside each beat. Selection can then
            // change at the pose boundary without a beam popping across the cover.
            const weave = Math.sin(Math.PI * choreography.travel) * drive * envelope;
            let frontBeams = 0;
            if (weave > .002) {
                for (let index = 0; index < 6; index++) {
                    const oldTarget = laserTargetForBeat(choreography.from, index);
                    const newTarget = laserTargetForBeat(choreography.to, index);
                    const movingInward = Math.abs(oldTarget.x - .5)
                        - Math.abs(newTarget.x - .5) > .035;
                    // One readable depth rule for the whole rig: contracting beams
                    // weave in front of the cover, expanding beams remain behind it.
                    if (!movingInward) continue;
                    const calmTarget = calmLaserTarget(timestamp, index, bpm);
                    const beatX = oldTarget.x
                        + (newTarget.x - oldTarget.x) * choreography.travel;
                    const beatY = oldTarget.y
                        + (newTarget.y - oldTarget.y) * choreography.travel;
                    const normalizedTargetX = calmTarget.x
                        + (beatX - calmTarget.x) * drive;
                    const targetX = width * (webglCoordinates
                        ? .5 + (normalizedTargetX - .5) * 1.18
                        : normalizedTargetX);
                    const targetY = height
                        * (1 - calmTarget.y - (beatY - calmTarget.y) * drive);
                    const strength = Math.min(1,
                        (mids * .72 + highs * .32 + beat * drive) * envelope);
                    const lane = (index + .5) / 6;
                    const originX = width * (webglCoordinates ? .02 + lane * .96 : lane);
                    const originY = height * ((webglCoordinates ? .035 : .04)
                        + (index % 2) * .025);
                    drawCanvasBeam(context, originX, originY,
                        targetX, targetY, LASER_COLORS[index], strength,
                        beat * drive * envelope, weave);
                    drawCanvasLandingSpot(context, targetX, targetY, LASER_COLORS[index],
                        strength, beat * drive * envelope, Math.min(width, height), weave);
                    frontBeams++;
                }
            }
            const liveSmokeParticles = smokeParticles.draw(context, width, height, {
                smokeEnabled,
                smokePreview,
                smokeBurstId,
                smokeAge
            });
            if (liveSmokeParticles > 0) {
                canvas.dataset.smokePaintedFrames = String(++smokePaintedFrames);
            }
            if (strobe > .002) {
                context.save();
                context.globalCompositeOperation = "screen";
                context.fillStyle = "#eefaff";
                context.globalAlpha = Math.min(.72, strobe * envelope * .72);
                context.fillRect(0, 0, width, height);
                context.restore();
                canvas.dataset.strobePaintedFrames = String(++strobePaintedFrames);
            }
            canvas.dataset.frontBeams = String(frontBeams);
            if (frontBeams > 0)
                canvas.dataset.frontPaintedFrames = String(++paintedFrames);
            canvas.dataset.strobeLevel = strobe.toFixed(3);
            canvas.dataset.smokeLevel = smoke.toFixed(3);
            canvas.dataset.smokeParticles = String(liveSmokeParticles);
        }
    };
}

export function createTempoAnalysisProducer() {
    let bass = 0;
    let mids = 0;
    let highs = 0;
    let bassMean = 0;
    let bassVariance = .0025;
    let fluxMean = .01;
    let previousBins = null;
    let beat = 0;
    let beatCount = 1;
    let beatAt = -10000;
    let accentAt = -10000;
    let accentCount = 0;
    let drive = 0;
    let estimatedBpm = 0;
    let frames = 0;
    const onsetTimes = [];
    const beatIntervals = [];
    const spectrumBands = new Float32Array(32);
    const analysis = { spectrumBands };

    function averageBand(data, from, to) {
        const start = Math.max(1, Math.floor(data.length * from));
        const end = Math.max(start + 1, Math.min(data.length, Math.ceil(data.length * to)));
        let total = 0;
        for (let index = start; index < end; index++) total += data[index];
        return total / ((end - start) * 255);
    }

    function processFrame(data, timestamp, synthetic) {
        const rawBass = averageBand(data, .003, .018);
        const rawMids = averageBand(data, .018, .2);
        const rawHighs = averageBand(data, .2, .72);
        bass += (rawBass - bass) * .42;
        mids += (rawMids - mids) * .24;
        highs += (rawHighs - highs) * .18;

        for (let band = 0; band < spectrumBands.length; band++) {
            const from = Math.pow(band / spectrumBands.length, 1.72) * .82;
            const to = Math.pow((band + 1) / spectrumBands.length, 1.72) * .82;
            const value = averageBand(data, from, Math.max(to, from + .006));
            const speed = value > spectrumBands[band] ? .8 : .58;
            spectrumBands[band] += (value - spectrumBands[band]) * speed;
        }

        if (!previousBins || previousBins.length !== data.length)
            previousBins = new Float32Array(data.length);
        const fluxEnd = Math.max(3, Math.floor(data.length * .065));
        let flux = 0;
        let fluxWeight = 0;
        for (let index = 1; index < fluxEnd; index++) {
            const value = data[index] / 255;
            const weight = 1 - index / fluxEnd * .55;
            flux += Math.max(0, value - previousBins[index]) * weight;
            fluxWeight += weight;
            previousBins[index] = value;
        }
        flux /= Math.max(1, fluxWeight);

        if (frames === 0) bassMean = rawBass;
        const deviation = rawBass - bassMean;
        bassMean += deviation * .025;
        bassVariance += (deviation * deviation - bassVariance) * .035;
        fluxMean += (flux - fluxMean) * .045;
        frames++;

        let onset = false;
        let accent = false;
        if (!synthetic && frames > 4) {
            const bassThreshold = .012 + Math.sqrt(Math.max(.0001, bassVariance)) * 1.05;
            const fluxThreshold = .003 + fluxMean * 1.35;
            const bassScore = Math.max(0, deviation) / bassThreshold;
            const fluxScore = flux / fluxThreshold;
            const sinceBeat = timestamp - beatAt;
            const onsetScore = bassScore * .82 + fluxScore * .36;
            onset = sinceBeat > 240 && rawBass > .08
                && bassScore > .62 && fluxScore > .55 && onsetScore > 1.15;
            accent = !onset && sinceBeat >= 80 && sinceBeat <= 240
                && timestamp - accentAt >= 80 && rawBass > .09
                && bassScore > .72 && fluxScore > .64 && onsetScore > 1.28;
        }
        if (onset) {
            if (beatAt > 0) {
                const interval = timestamp - beatAt;
                if (interval >= 240 && interval <= 1500) {
                    beatIntervals.push(interval);
                    if (beatIntervals.length > 7) beatIntervals.shift();
                    const ordered = [...beatIntervals].sort((left, right) => left - right);
                    let bpm = 60000 / ordered[Math.floor(ordered.length / 2)];
                    while (bpm < 80) bpm *= 2;
                    while (bpm > 160) bpm /= 2;
                    estimatedBpm += (bpm - estimatedBpm) * (estimatedBpm ? .28 : 1);
                }
            }
            beat = 1;
            beatAt = timestamp;
            accentAt = timestamp;
            beatCount++;
            onsetTimes.push(timestamp);
        } else if (accent) {
            accentAt = timestamp;
            accentCount++;
            beat = Math.min(1.7, Math.max(1, beat + .65));
        } else {
            const beatPeriod = estimatedBpm ? 60000 / estimatedBpm : 500;
            const release = Math.max(140, Math.min(320, beatPeriod * .42));
            beat *= Math.pow(.08, 33 / release);
        }
        while (onsetTimes.length && timestamp - onsetTimes[0] > 3000)
            onsetTimes.shift();
        const rhythmic = !synthetic && onsetTimes.length >= 2
            && timestamp - beatAt < 1500;
        drive += ((rhythmic ? 1 : 0) - drive) * (rhythmic ? .18 : .035);
        if (drive < .001) drive = 0;
    }

    return {
        id: "tempo-analysis",
        needs: [ANALYSER_FACTS.timestamp, ANALYSER_FACTS.frequencyData,
            ANALYSER_FACTS.synthetic],
        provides: [ANALYSER_FACTS.tempoAnalysis, ANALYSER_FACTS.bpm],
        process(blackboard) {
            const timestamp = blackboard.get(ANALYSER_FACTS.timestamp);
            const data = blackboard.get(ANALYSER_FACTS.frequencyData);
            const synthetic = !!blackboard.get(ANALYSER_FACTS.synthetic);
            if (!data || !data.length) return;
            processFrame(data, timestamp, synthetic);
            Object.assign(analysis, {
                timestamp, synthetic, bass, mids, highs, beat, beatCount,
                beatAge: Math.max(0, timestamp - beatAt), accentCount,
                drive, bpm: estimatedBpm
            });
            blackboard.set(ANALYSER_FACTS.tempoAnalysis, analysis);
            blackboard.set(ANALYSER_FACTS.bpm, estimatedBpm || 0);
        },
        reset(blackboard) {
            bass = mids = highs = bassMean = 0;
            bassVariance = .0025;
            fluxMean = .01;
            previousBins = null;
            beat = 0;
            beatCount = 1;
            beatAt = accentAt = -10000;
            accentCount = 0;
            drive = estimatedBpm = 0;
            frames = 0;
            onsetTimes.length = beatIntervals.length = 0;
            spectrumBands.fill(0);
            blackboard.delete(ANALYSER_FACTS.tempoAnalysis);
            blackboard.delete(ANALYSER_FACTS.bpm);
        }
    };
}

export function createLaserVisualization({ canvas, foregroundCanvas, hasCapability }) {
    // Rendering is a pure blackboard consumer. Beat and tempo analysis belongs to
    // createTempoAnalysisProducer and only runs while a consumer demands its facts.
    const renderer = createLaserWebGlRenderer(canvas) || createLaserCanvasRenderer(canvas);
    const foregroundRenderer = createLaserForegroundRenderer(foregroundCanvas,
        !!renderer && renderer.type === "webgl",
        !!renderer && renderer.type === "webgl" && renderer.gpuTier === "hardware");
    let lastBeatCount = 1;
    let lastAccentCount = 0;
    let hasAnalysisFrame = false;
    let strobeAt = -10000;
    let strobeCount = 0;
    let smokeAt = -10000;
    let smokeCount = 0;
    let smokePreview = false;
    let beatFrame = null;

    function restartBeatMarker() {
        canvas.classList.remove("beat");
        // Restart the beat marker without forcing layout. Accents use the same marker
        // so CSS-driven additions can react to both primary and double hits.
        if (beatFrame !== null) cancelAnimationFrame(beatFrame);
        beatFrame = requestAnimationFrame(() => {
            beatFrame = null;
            if (canvas.classList.contains("active")) canvas.classList.add("beat");
        });
    }

    function clear() {
        lastBeatCount = 1;
        lastAccentCount = 0;
        hasAnalysisFrame = false;
        strobeAt = -10000;
        strobeCount = 0;
        smokeAt = -10000;
        smokeCount = 0;
        smokePreview = false;
        if (beatFrame !== null) cancelAnimationFrame(beatFrame);
        beatFrame = null;
        canvas.classList.remove("beat");
        canvas.dataset.frame = "0";
        canvas.dataset.beatCount = "1";
        canvas.dataset.beatAccentCount = "0";
        canvas.dataset.strobeCount = "0";
        canvas.dataset.strobeLevel = "0";
        canvas.dataset.smokeCount = "0";
        canvas.dataset.smokeLevel = "0";
        canvas.dataset.laserMode = "calm";
        canvas.dataset.bpm = "";
        if (renderer) renderer.clear();
        if (foregroundRenderer) foregroundRenderer.clear();
    }

    function trigger(effect, timestamp) {
        if (effect !== "smoke") return false;
        smokeAt = timestamp;
        smokeCount++;
        smokePreview = true;
        canvas.dataset.smokeCount = String(smokeCount);
        return true;
    }

    canvas.dataset.renderer = renderer ? renderer.type : "none";
    canvas.dataset.rigOrigin = "ceiling";
    canvas.dataset.landingSpots = "6";
    canvas.dataset.strobePattern = "occasional-double";
    canvas.dataset.smokePattern = "two-front-particle-emitters";
    canvas.dataset.spectrumBands = "32";
    if (foregroundCanvas) {
        foregroundCanvas.dataset.renderer = foregroundRenderer ? "canvas" : "none";
        foregroundCanvas.dataset.rigOrigin = "ceiling";
    }
    return {
        id: "lasers",
        needs: [ANALYSER_FACTS.tempoAnalysis],
        supportsSyntheticData: true,
        enabled(options) {
            return !!options.laserEnabled && !options.milkdropEnabled
                && !!hasCapability("lasers");
        },
        setActive(active) {
            canvas.classList.toggle("active", active);
            if (foregroundCanvas) foregroundCanvas.classList.toggle("active", active);
            const stage = canvas.closest(".stage");
            if (stage) stage.classList.toggle("laser-scene", active);
        },
        trigger,
        clear,
        draw({ blackboard, envelope, options }) {
            const analysis = blackboard.get(ANALYSER_FACTS.tempoAnalysis);
            if (!renderer || !analysis) return;
            const { timestamp, synthetic, bass, mids, highs, beat, beatCount,
                beatAge, accentCount, drive, bpm, spectrumBands } = analysis;
            canvas.dataset.audioSource = synthetic ? "ambient" : "spectrum";
            const strobeEnabled = !!(options && options.strobeEnabled);
            const smokeEnabled = !!(options && options.smokeEnabled);
            if (!strobeEnabled) strobeAt = -10000;
            if (!smokeEnabled) {
                smokeAt = -10000;
                smokePreview = false;
            }

            if (!hasAnalysisFrame) {
                lastBeatCount = beatCount;
                lastAccentCount = accentCount;
                hasAnalysisFrame = true;
            } else {
                if (beatCount > lastBeatCount) {
                    restartBeatMarker();
                    if (strobeEnabled && drive >= .42 && beatCount % 8 === 0
                            && timestamp - strobeAt >= 1800) {
                        strobeAt = timestamp;
                        strobeCount++;
                    }
                    if (smokeEnabled && drive >= .42 && beatCount % 8 === 4
                            && timestamp - smokeAt >= 2200) {
                        smokeAt = timestamp;
                        smokeCount++;
                        smokePreview = false;
                    }
                }
                if (accentCount > lastAccentCount) restartBeatMarker();
                lastBeatCount = beatCount;
                lastAccentCount = accentCount;
            }

            canvas.dataset.beatCount = String(beatCount);
            canvas.dataset.beatAccentCount = String(accentCount);
            canvas.dataset.laserMode = drive >= .42 ? "beat" : "calm";
            canvas.dataset.bpm = bpm ? String(Math.round(bpm)) : "";
            canvas.dataset.strobeCount = String(strobeCount);
            canvas.dataset.smokeCount = String(smokeCount);
            const strobe = strobeEnvelope(timestamp, strobeAt, strobeEnabled);
            const smoke = smokeEnvelope(timestamp, smokeAt, smokeEnabled, smokePreview);
            canvas.dataset.strobeLevel = strobe.toFixed(3);
            canvas.dataset.smokeLevel = smoke.toFixed(3);
            canvas.dataset.smokeSource = smokePreview ? "preview" : "beat";
            const renderFrame = {
                timestamp,
                bass,
                mids,
                highs,
                beat,
                beatCount,
                beatAge,
                envelope,
                drive,
                bpm,
                strobe,
                smoke,
                smokeAge: Math.max(0, (timestamp - smokeAt) / 1000),
                smokeEnabled,
                smokePreview,
                smokeBurstId: smokeCount,
                spectrumBands
            };
            renderer.draw(renderFrame);
            if (foregroundRenderer) foregroundRenderer.draw(renderFrame);
            canvas.dataset.frame = String((Number(canvas.dataset.frame) || 0) + 1);
        }
    };
}

export function createBpmVisualization({ element }) {
    let displayedBpm = "";
    let clearTimer = null;

    function render(value) {
        if (!element) return;
        const rounded = value ? String(Math.round(value)) : "";
        if (rounded === displayedBpm) return;
        displayedBpm = rounded;
        element.dataset.bpm = rounded;
        const valueElement = element.querySelector(".stage-bpm-value");
        if (valueElement) valueElement.textContent = rounded || "—";
        element.classList.toggle("has-value", !!rounded);
        element.setAttribute("aria-label", rounded
            ? `${rounded} beats per minute`
            : "Estimating tempo");
    }

    return {
        id: "bpm",
        needs: [ANALYSER_FACTS.bpm],
        supportsSyntheticData: true,
        enabled(options) {
            return !!options.bpmEnabled;
        },
        setActive(active) {
            if (!element) return;
            clearTimeout(clearTimer);
            clearTimer = null;
            element.classList.toggle("active", active);
            element.setAttribute("aria-hidden", active ? "false" : "true");
            if (active) {
                // Each entrance starts honestly while the producer gathers samples.
                render(0);
            } else {
                // Retain outgoing content until the badge's opacity transition ends.
                clearTimer = setTimeout(() => {
                    clearTimer = null;
                    render(0);
                }, 300);
            }
        },
        clear() {
            // setActive(false) owns delayed content cleanup so exits stay visible.
        },
        draw({ blackboard }) {
            render(blackboard ? blackboard.get(ANALYSER_FACTS.bpm) || 0 : 0);
        }
    };
}

export function createAudioAnalyserController({
    audioElement,
    getOptions,
    isAudioWanted,
    hasAudioPlayed,
    reducedMotion,
    visualizations,
    producers = []
}) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const sourceFacts = new Set([
        ANALYSER_FACTS.timestamp,
        ANALYSER_FACTS.frequencyData,
        ANALYSER_FACTS.timeDomainData,
        ANALYSER_FACTS.synthetic
    ]);
    const states = visualizations.map(visualization => ({
        visualization,
        envelope: 0,
        from: 0,
        target: 0,
        started: 0
    }));
    const producerByFact = new Map();
    producers.forEach(producer => {
        if (!producer.id || typeof producer.process !== "function"
                || !Array.isArray(producer.provides) || !producer.provides.length)
            throw new Error("Invalid analyser producer");
        producer.provides.forEach(fact => {
            if (producerByFact.has(fact))
                throw new Error(`Duplicate analyser fact provider: ${fact}`);
            producerByFact.set(fact, producer);
        });
    });
    producers.forEach(producer => {
        (producer.needs || []).forEach(fact => {
            if (!sourceFacts.has(fact) && !producerByFact.has(fact))
                throw new Error(`Missing analyser fact provider: ${fact}`);
        });
    });
    visualizations.forEach(visualization => {
        if (!Array.isArray(visualization.needs)) return;
        visualization.needs.forEach(fact => {
            if (!sourceFacts.has(fact) && !producerByFact.has(fact))
                throw new Error(`Missing analyser fact provider: ${fact}`);
        });
    });
    const validatedProducers = new Set();
    const validatingProducers = new Set();
    function validateProducer(producer) {
        if (validatedProducers.has(producer)) return;
        if (validatingProducers.has(producer))
            throw new Error(`Cyclic analyser fact dependency: ${producer.id}`);
        validatingProducers.add(producer);
        (producer.needs || []).forEach(fact => {
            const dependency = producerByFact.get(fact);
            if (dependency) validateProducer(dependency);
        });
        validatingProducers.delete(producer);
        validatedProducers.add(producer);
    }
    producers.forEach(validateProducer);

    // The blackboard is one controller-local frame snapshot. Consumers declare facts;
    // producers are activated by the transitive closure of that demand, never by
    // subscribe/unsubscribe side effects.
    const blackboard = new Map();
    let activeProducers = new Set();
    let audioContext = null;
    let source = null;
    let analyser = null;
    let frequencyData = null;
    let timeDomainData = null;
    let usesSyntheticData = false;
    let frame = null;
    let lastFrame = 0;

    function fillSyntheticData(data, timeData, timestamp) {
        const beat = .5 + Math.sin(timestamp * .0042) * .3
            + Math.sin(timestamp * .00137) * .2;
        if (data) {
            for (let index = 0; index < data.length; index++) {
                const position = index / data.length;
                const rolloff = Math.pow(1 - position, .72);
                const ripple = .5 + .5 * Math.sin(timestamp * .0021 + index * .19);
                data[index] = Math.round(255 * Math.min(1,
                    (.16 + beat * .42 + ripple * .2) * rolloff));
            }
        }
        if (timeData) {
            for (let index = 0; index < timeData.length; index++) {
                const position = index / timeData.length;
                timeData[index] = Math.round(128
                    + Math.sin(position * Math.PI * 6 + timestamp * .0011) * 24
                    + Math.sin(position * Math.PI * 14 - timestamp * .0007) * 9);
            }
        }
    }

    function componentNeeds(component, options) {
        const needs = typeof component.needs === "function"
            ? component.needs(options) : component.needs || [];
        if (!Array.isArray(needs))
            throw new Error(`Invalid analyser fact requirements: ${component.id}`);
        return needs;
    }

    function resolveDemand(consumerStates, options) {
        const facts = new Set();
        const orderedProducers = [];
        const resolved = new Set();
        const resolving = new Set();

        function requireFact(fact) {
            facts.add(fact);
            if (sourceFacts.has(fact)) return;
            const producer = producerByFact.get(fact);
            if (!producer) throw new Error(`Missing analyser fact provider: ${fact}`);
            if (resolved.has(producer)) return;
            if (resolving.has(producer))
                throw new Error(`Cyclic analyser fact dependency: ${producer.id}`);
            resolving.add(producer);
            (producer.needs || []).forEach(requireFact);
            resolving.delete(producer);
            resolved.add(producer);
            orderedProducers.push(producer);
        }

        consumerStates.forEach(state =>
            componentNeeds(state.visualization, options).forEach(requireFact));
        return { facts, producers: orderedProducers };
    }

    function syncProducerLifecycle(requiredProducers) {
        const required = new Set(requiredProducers);
        activeProducers.forEach(producer => {
            if (!required.has(producer) && producer.reset) producer.reset(blackboard);
        });
        required.forEach(producer => {
            if (!activeProducers.has(producer) && producer.start)
                producer.start(blackboard);
        });
        activeProducers = required;
    }

    function stopProducers() {
        activeProducers.forEach(producer => {
            if (producer.reset) producer.reset(blackboard);
        });
        activeProducers.clear();
        sourceFacts.forEach(fact => blackboard.delete(fact));
    }

    function updateEnvelope(state, timestamp) {
        const progress = Math.min(1, Math.max(0,
            (timestamp - state.started) / ENVELOPE_MS));
        const eased = smoothstep(progress);
        state.envelope = state.from + (state.target - state.from) * eased;
        return progress >= 1;
    }

    function targetEnvelope(state, target, timestamp) {
        if (state.target === target) return;
        updateEnvelope(state, timestamp);
        state.from = state.envelope;
        state.target = target;
        state.started = timestamp;
        if (target) state.visualization.setActive(true);
    }

    function stopState(state) {
        state.envelope = state.from = state.target = 0;
        state.visualization.clear(blackboard);
        state.visualization.setActive(false);
    }

    function draw(timestamp) {
        frame = null;
        if (timestamp - lastFrame < 33) {
            frame = requestAnimationFrame(draw);
            return;
        }
        lastFrame = timestamp;
        const options = getOptions();
        const drawStates = [];
        let keepDrawing = false;
        states.forEach(state => {
            const done = updateEnvelope(state, timestamp);
            if (state.target === 0 && done) {
                stopState(state);
                return;
            }
            if (state.envelope > 0) drawStates.push(state);
            if (state.envelope > 0 || !done) keepDrawing = true;
        });

        const demand = resolveDemand(drawStates, options);
        syncProducerLifecycle(demand.producers);
        blackboard.set(ANALYSER_FACTS.timestamp, timestamp);
        blackboard.set(ANALYSER_FACTS.synthetic, usesSyntheticData);
        const needsFrequency = demand.facts.has(ANALYSER_FACTS.frequencyData);
        const needsTimeDomain = demand.facts.has(ANALYSER_FACTS.timeDomainData);
        if (usesSyntheticData && (needsFrequency || needsTimeDomain)) {
            fillSyntheticData(needsFrequency ? frequencyData : null,
                needsTimeDomain ? timeDomainData : null, timestamp);
        } else {
            if (needsFrequency && analyser) analyser.getByteFrequencyData(frequencyData);
            if (needsTimeDomain && analyser
                    && typeof analyser.getByteTimeDomainData === "function")
                analyser.getByteTimeDomainData(timeDomainData);
        }
        if (needsFrequency) blackboard.set(ANALYSER_FACTS.frequencyData, frequencyData);
        else blackboard.delete(ANALYSER_FACTS.frequencyData);
        if (needsTimeDomain) blackboard.set(ANALYSER_FACTS.timeDomainData, timeDomainData);
        else blackboard.delete(ANALYSER_FACTS.timeDomainData);

        demand.producers.forEach(producer => producer.process(blackboard));

        drawStates.forEach(state => {
            state.visualization.draw({
                blackboard,
                envelope: state.envelope,
                releasing: state.target === 0,
                options
            });
        });
        if (keepDrawing) frame = requestAnimationFrame(draw);
    }

    function sync() {
        const now = performance.now();
        const options = getOptions();
        if (reducedMotion.matches || document.hidden) {
            states.forEach(stopState);
            stopProducers();
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            return;
        }
        const canRun = !!(isAudioWanted() && hasAudioPlayed() && frequencyData
            && !document.hidden && !reducedMotion.matches);
        let needsFrame = false;
        states.forEach(state => {
            const active = canRun && state.visualization.enabled(options)
                && (!usesSyntheticData || state.visualization.supportsSyntheticData);
            targetEnvelope(state, active ? 1 : 0, now);
            if (active || state.envelope > 0 || state.target !== state.envelope)
                needsFrame = true;
        });
        if (needsFrame) {
            if (frame === null) frame = requestAnimationFrame(draw);
            return;
        }
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        stopProducers();
    }

    function prepare() {
        const options = getOptions();
        const enabledStates = states.filter(state => state.visualization.enabled(options));
        if (!enabledStates.length || reducedMotion.matches) return false;
        const demand = resolveDemand(enabledStates, options);
        if (![...demand.facts].some(fact => sourceFacts.has(fact))) return false;
        if (!AudioContextCtor) {
            if (!enabledStates.some(state => state.visualization.supportsSyntheticData))
                return false;
            usesSyntheticData = true;
            if (!frequencyData) frequencyData = new Uint8Array(128);
            if (!timeDomainData) timeDomainData = new Uint8Array(256);
            return true;
        }
        if (!analyser && !usesSyntheticData) {
            try {
                audioContext = new AudioContextCtor();
                analyser = audioContext.createAnalyser();
                // The shared tempo producer needs enough low-frequency resolution to
                // separate kick/bass onsets from the mids. Consumers smooth their own
                // presentation, so keep analyser smoothing light enough to preserve attacks.
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = .32;
                source = audioContext.createMediaElementSource(audioElement);
                source.connect(analyser);
                analyser.connect(audioContext.destination);
                frequencyData = new Uint8Array(analyser.frequencyBinCount);
                timeDomainData = new Uint8Array(analyser.fftSize
                    || analyser.frequencyBinCount * 2);
            } catch (error) {
                audioContext = source = analyser = frequencyData = timeDomainData = null;
                if (!enabledStates.some(state => state.visualization.supportsSyntheticData))
                    return false;
                usesSyntheticData = true;
                frequencyData = new Uint8Array(128);
                timeDomainData = new Uint8Array(256);
                return true;
            }
        }
        if (audioContext && audioContext.state === "suspended") {
            const resumed = audioContext.resume();
            if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
        }
        return true;
    }

    function clear(id) {
        states.filter(state => !id || state.visualization.id === id)
            .forEach(state => state.visualization.clear(blackboard));
    }

    function reset(id) {
        states.filter(state => !id || state.visualization.id === id)
            .forEach(state => {
                if (state.visualization.reset) state.visualization.reset();
            });
    }

    function trigger(id, effect) {
        const state = states.find(candidate => candidate.visualization.id === id);
        if (!state || state.target !== 1 || !state.visualization.trigger) return false;
        const triggered = state.visualization.trigger(effect, performance.now());
        if (triggered && frame === null) frame = requestAnimationFrame(draw);
        return triggered;
    }

    document.addEventListener("visibilitychange", sync);
    if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", sync);
    else if (reducedMotion.addListener) reducedMotion.addListener(sync);

    return { blackboard, clear, prepare, reset, sync, trigger };
}

export function createAudioVisualizationController({
    audioElement,
    spectrumElement,
    milkdropElement,
    laserElement,
    laserForegroundElement,
    bpmElement,
    infoElement,
    getOptions,
    hasCapability,
    isAudioWanted,
    hasAudioPlayed,
    reducedMotion
}) {
    return createAudioAnalyserController({
        audioElement,
        getOptions,
        isAudioWanted,
        hasAudioPlayed,
        reducedMotion,
        producers: [createTempoAnalysisProducer()],
        visualizations: [
            createSpectrumVisualization({ canvas: spectrumElement, tintElement: infoElement }),
            createMilkdropVisualization({
                canvas: milkdropElement,
                tintElement: infoElement,
                facts: ANALYSER_FACTS
            }),
            createLaserVisualization({
                canvas: laserElement,
                foregroundCanvas: laserForegroundElement,
                hasCapability
            }),
            createBpmVisualization({ element: bpmElement })
        ]
    });
}

// Kept for older cached player.js builds during a rolling static-site deploy.
export const createAudioSpectrumController = createAudioVisualizationController;
