// Shared Web Audio analyser + small visualization plugins.
//
// The controller owns the media source, reads the analyser once per frame, and
// hands that immutable frame to each enabled visualization. A plugin only needs
// `enabled`, `draw`, `clear`, and `setActive`; it never creates another AudioContext
// or animation loop. That keeps future station-specific scenes cheap to add while
// the media element remains the one source of truth for playback.

const ENVELOPE_MS = 400;

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

export function createSpectrumVisualization({ canvas, tintElement }) {
    const context = canvas.getContext("2d");
    let peaks = [];

    function clear() {
        peaks = [];
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
    }

    return {
        id: "spectrum",
        enabled(options) { return !!options.spectrumEnabled; },
        setActive(active) { canvas.classList.toggle("active", active); },
        clear,
        reset() { peaks = []; },
        draw({ frequencyData, envelope, releasing, options }) {
            if (!context || !frequencyData || !frequencyData.length) return;
            if (resizeCanvas(canvas)) peaks = [];

            const width = canvas.width;
            const height = canvas.height;
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
            context.clearRect(0, 0, width, height);
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

    function clear() {
        context.clearRect(0, 0, canvas.width, canvas.height);
        paintedFrames = 0;
        strobePaintedFrames = 0;
        canvas.dataset.frontBeams = "0";
        canvas.dataset.frontPaintedFrames = "0";
        canvas.dataset.strobePaintedFrames = "0";
        canvas.dataset.strobeLevel = "0";
    }

    return {
        clear,
        draw({ timestamp, mids, highs, beat, beatCount, beatAge, envelope,
            drive, bpm, strobe }) {
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
        }
    };
}

export function createLaserVisualization({ canvas, foregroundCanvas }) {
    // WebGL is the browser equivalent of OpenGL. The 2D renderer is deliberately a
    // compatibility path; both consume the same adaptive beat detector below.
    const renderer = createLaserWebGlRenderer(canvas) || createLaserCanvasRenderer(canvas);
    const foregroundRenderer = createLaserForegroundRenderer(foregroundCanvas,
        !!renderer && renderer.type === "webgl",
        !!renderer && renderer.type === "webgl" && renderer.gpuTier === "hardware");
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
    let strobeAt = -10000;
    let strobeCount = 0;
    let drive = 0;
    let estimatedBpm = 0;
    const onsetTimes = [];
    const beatIntervals = [];
    let frames = 0;
    let beatFrame = null;
    const spectrumBands = new Float32Array(32);

    function averageBand(data, from, to) {
        const start = Math.max(1, Math.floor(data.length * from));
        const end = Math.max(start + 1, Math.min(data.length, Math.ceil(data.length * to)));
        let total = 0;
        for (let index = start; index < end; index++) total += data[index];
        return total / ((end - start) * 255);
    }

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

    function detectBeat(data, timestamp, synthetic, strobeEnabled) {
        // Keep the trigger down in the kick/bass region. The old wide band reached
        // well into the low mids, so vocals and synth stabs looked like random beats.
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
            // The compact analyzer already feels immediate because it consumes the
            // shared analyser values directly. Keep the wall's band averaging, but
            // avoid a visibly sluggish second smoothing pass—especially on release.
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
        if (synthetic) {
            // With no real analyser there is no honest beat information. Stay in
            // Slow Dance mode instead of inventing a metronome for the lasers.
            onset = false;
        } else if (frames > 4) {
            const bassThreshold = .012 + Math.sqrt(Math.max(.0001, bassVariance)) * 1.05;
            const fluxThreshold = .003 + fluxMean * 1.35;
            const bassScore = Math.max(0, deviation) / bassThreshold;
            const fluxScore = flux / fluxThreshold;
            const sinceBeat = timestamp - beatAt;
            const onsetScore = bassScore * .82 + fluxScore * .36;
            onset = sinceBeat > 240 && rawBass > .08
                && bassScore > .62 && fluxScore > .55 && onsetScore > 1.15;
            // A strong transient inside the BPM refractory window is a double-hit,
            // not a new tempo sample. Give it visual energy without moving beatAt.
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
            // One restrained double flash per eight-beat phrase. Requiring an
            // established rhythmic drive prevents ballads and detector warm-up from
            // producing an isolated surprise flash.
            if (strobeEnabled && drive >= .42 && beatCount % 8 === 0
                    && timestamp - strobeAt >= 1800) {
                strobeAt = timestamp;
                strobeCount++;
            }
            onsetTimes.push(timestamp);
            restartBeatMarker();
        } else if (accent) {
            accentAt = timestamp;
            accentCount++;
            // Stack the double-hit on the still-decaying primary pulse. Values above
            // one deliberately overdrive the beam halo and diffraction for the accent.
            beat = Math.min(1.7, Math.max(1, beat + .65));
            restartBeatMarker();
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
        canvas.dataset.laserMode = drive >= .42 ? "beat" : "calm";
        canvas.dataset.bpm = estimatedBpm ? String(Math.round(estimatedBpm)) : "";
        canvas.dataset.beatAccentCount = String(accentCount);
        canvas.dataset.strobeCount = String(strobeCount);
    }

    function clear() {
        bass = mids = highs = bassMean = 0;
        bassVariance = .0025;
        fluxMean = .01;
        previousBins = null;
        beat = 0;
        beatCount = 1;
        beatAt = -10000;
        accentAt = -10000;
        accentCount = 0;
        strobeAt = -10000;
        strobeCount = 0;
        drive = 0;
        estimatedBpm = 0;
        onsetTimes.length = 0;
        beatIntervals.length = 0;
        frames = 0;
        spectrumBands.fill(0);
        if (beatFrame !== null) cancelAnimationFrame(beatFrame);
        beatFrame = null;
        canvas.classList.remove("beat");
        canvas.dataset.frame = "0";
        canvas.dataset.beatCount = "1";
        canvas.dataset.beatAccentCount = "0";
        canvas.dataset.strobeCount = "0";
        canvas.dataset.strobeLevel = "0";
        canvas.dataset.laserMode = "calm";
        canvas.dataset.bpm = "";
        if (renderer) renderer.clear();
        if (foregroundRenderer) foregroundRenderer.clear();
    }

    canvas.dataset.renderer = renderer ? renderer.type : "none";
    canvas.dataset.rigOrigin = "ceiling";
    canvas.dataset.landingSpots = "6";
    canvas.dataset.strobePattern = "occasional-double";
    canvas.dataset.spectrumBands = String(spectrumBands.length);
    if (foregroundCanvas) {
        foregroundCanvas.dataset.renderer = foregroundRenderer ? "canvas" : "none";
        foregroundCanvas.dataset.rigOrigin = "ceiling";
    }
    return {
        id: "lasers",
        supportsSyntheticData: true,
        enabled(options) { return !!options.laserEnabled && options.station === "1980s"; },
        setActive(active) {
            canvas.classList.toggle("active", active);
            if (foregroundCanvas) foregroundCanvas.classList.toggle("active", active);
            const stage = canvas.closest(".stage");
            if (stage) stage.classList.toggle("laser-scene", active);
        },
        clear,
        draw({ timestamp, frequencyData, envelope, synthetic, options }) {
            if (!renderer || !frequencyData || !frequencyData.length) return;
            canvas.dataset.audioSource = synthetic ? "ambient" : "spectrum";
            const strobeEnabled = !!(options && options.strobeEnabled);
            if (!strobeEnabled) strobeAt = -10000;
            detectBeat(frequencyData, timestamp, synthetic, strobeEnabled);
            canvas.dataset.beatCount = String(beatCount);
            const strobe = strobeEnvelope(timestamp, strobeAt, strobeEnabled);
            canvas.dataset.strobeLevel = strobe.toFixed(3);
            const renderFrame = {
                timestamp,
                bass,
                mids,
                highs,
                beat,
                beatCount,
                beatAge: Math.max(0, timestamp - beatAt),
                envelope,
                drive,
                bpm: estimatedBpm,
                strobe,
                spectrumBands
            };
            renderer.draw(renderFrame);
            if (foregroundRenderer) foregroundRenderer.draw(renderFrame);
            canvas.dataset.frame = String((Number(canvas.dataset.frame) || 0) + 1);
        }
    };
}

export function createAudioAnalyserController({
    audioElement,
    getOptions,
    isAudioWanted,
    hasAudioPlayed,
    reducedMotion,
    visualizations
}) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const states = visualizations.map(visualization => ({
        visualization,
        envelope: 0,
        from: 0,
        target: 0,
        started: 0
    }));
    let audioContext = null;
    let source = null;
    let analyser = null;
    let frequencyData = null;
    let usesSyntheticData = false;
    let frame = null;
    let lastFrame = 0;

    function fillSyntheticData(data, timestamp) {
        const beat = .5 + Math.sin(timestamp * .0042) * .3
            + Math.sin(timestamp * .00137) * .2;
        for (let index = 0; index < data.length; index++) {
            const position = index / data.length;
            const rolloff = Math.pow(1 - position, .72);
            const ripple = .5 + .5 * Math.sin(timestamp * .0021 + index * .19);
            data[index] = Math.round(255 * Math.min(1,
                (.16 + beat * .42 + ripple * .2) * rolloff));
        }
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
        state.visualization.clear();
        state.visualization.setActive(false);
    }

    function draw(timestamp) {
        frame = null;
        if (timestamp - lastFrame < 33) {
            frame = requestAnimationFrame(draw);
            return;
        }
        lastFrame = timestamp;
        if (states.some(state => state.target === 1)) {
            if (usesSyntheticData) fillSyntheticData(frequencyData, timestamp);
            else analyser.getByteFrequencyData(frequencyData);
        }

        let keepDrawing = false;
        const options = getOptions();
        states.forEach(state => {
            const done = updateEnvelope(state, timestamp);
            if (state.target === 0 && done) {
                stopState(state);
                return;
            }
            if (state.envelope > 0) {
                state.visualization.draw({
                    timestamp,
                    frequencyData,
                    envelope: state.envelope,
                    releasing: state.target === 0,
                    synthetic: usesSyntheticData,
                    options
                });
                keepDrawing = true;
            }
            if (!done) keepDrawing = true;
        });
        if (keepDrawing) frame = requestAnimationFrame(draw);
    }

    function sync() {
        const now = performance.now();
        const options = getOptions();
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
        if (reducedMotion.matches || document.hidden) states.forEach(stopState);
    }

    function prepare() {
        const options = getOptions();
        const enabledStates = states.filter(state => state.visualization.enabled(options));
        if (!enabledStates.length || reducedMotion.matches) return false;
        if (!AudioContextCtor) {
            if (!enabledStates.some(state => state.visualization.supportsSyntheticData))
                return false;
            usesSyntheticData = true;
            if (!frequencyData) frequencyData = new Uint8Array(128);
            return true;
        }
        if (!analyser && !usesSyntheticData) {
            try {
                audioContext = new AudioContextCtor();
                analyser = audioContext.createAnalyser();
                // The laser beat detector needs enough low-frequency resolution to
                // separate kick/bass onsets from the mids. Plugins smooth their own
                // bands, so keep analyser smoothing light enough to preserve attacks.
                analyser.fftSize = 1024;
                analyser.smoothingTimeConstant = .32;
                source = audioContext.createMediaElementSource(audioElement);
                source.connect(analyser);
                analyser.connect(audioContext.destination);
                frequencyData = new Uint8Array(analyser.frequencyBinCount);
            } catch (error) {
                audioContext = source = analyser = frequencyData = null;
                if (!enabledStates.some(state => state.visualization.supportsSyntheticData))
                    return false;
                usesSyntheticData = true;
                frequencyData = new Uint8Array(128);
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
            .forEach(state => state.visualization.clear());
    }

    function reset(id) {
        states.filter(state => !id || state.visualization.id === id)
            .forEach(state => {
                if (state.visualization.reset) state.visualization.reset();
            });
    }

    document.addEventListener("visibilitychange", sync);
    if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", sync);
    else if (reducedMotion.addListener) reducedMotion.addListener(sync);

    return { clear, prepare, reset, sync };
}

export function createAudioVisualizationController({
    audioElement,
    spectrumElement,
    laserElement,
    laserForegroundElement,
    infoElement,
    getOptions,
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
        visualizations: [
            createSpectrumVisualization({ canvas: spectrumElement, tintElement: infoElement }),
            createLaserVisualization({
                canvas: laserElement,
                foregroundCanvas: laserForegroundElement
            })
        ]
    });
}

// Kept for older cached player.js builds during a rolling static-site deploy.
export const createAudioSpectrumController = createAudioVisualizationController;
