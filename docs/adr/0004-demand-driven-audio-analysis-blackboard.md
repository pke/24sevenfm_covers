# ADR 0004: Demand-driven audio analysis through a controller-local blackboard

Date: 2026-08-24
Status: Accepted

## Context

The web player has one Web Audio `AnalyserNode` and an animation loop shared by its
visualizations. Spectrum, oscilloscope, MilkDrop and the 1980s laser scene consume
different combinations of frequency samples, time-domain samples and derived audio
facts.

Beat and BPM estimation was originally implemented inside the laser visualization
because the laser was its only consumer. A user-visible BPM display adds a second
consumer. Passing that display into the laser, or making it observe laser DOM
attributes, would preserve the wrong ownership: the laser would remain both a tempo
producer and one particular tempo consumer.

More analyzer consumers are expected. They must not create additional
`AudioContext`s, analyzer reads, animation loops or point-to-point wiring. At the
same time, expensive work must not run merely because a producer exists. Frequency
sampling, waveform sampling and derived analysis are needed only while at least one
active consumer requires their results.

The project also requires outgoing visual content to remain rendered until its exit
transition completes. Demand lifetime therefore cannot be inferred only from a
checkbox value; a releasing visualization is still a visible consumer until its
render envelope reaches zero.

## Decision

Use a pure, controller-local **blackboard architecture** for analyzer data. Do not
use listener, observable or DOM-event subscriptions between audio-data producers and
consumers.

### Fact schema

The blackboard is a `Map` whose keys come from one exported fact schema. Raw facts
include at least:

- frame timestamp;
- frequency-domain samples;
- time-domain samples; and
- whether the samples are synthetic fallback data.

Derived facts include stable semantic values rather than producer-specific DOM
state, for example:

- estimated BPM and its availability/confidence;
- beat/onset state and beat count;
- smoothed bass, mid and high energy; and
- shared spectrum bands when multiple consumers need the same reduction.

Fact names describe the data, not their first consumer. `tempo.bpm` is valid;
`laser.bpm` is not.

The blackboard belongs to one audio-visualization controller instance. It is not a
window global, persistence store or cross-player event bus.

### Declarative consumers

Every visualization is registered once with the controller and declares the facts
it needs. Requirements may depend on current options:

```js
{
    id: "spectrum",
    needs(options) {
        return options.analyzerType === "oscilloscope"
            ? [FACTS.frequencyData, FACTS.timeDomainData]
            : [FACTS.frequencyData];
    },
    enabled(options) { return options.spectrumEnabled; },
    draw({ blackboard, envelope, options }) { /* read facts */ }
}
```

The laser declares tempo, beat and band facts. The BPM display declares the BPM
fact. Neither knows which producer supplies those facts or which other consumers
exist. Consumers read the current frame snapshot during their existing `draw` call;
they do not add or remove listeners.

### Declarative producers

Derived analysis is implemented by producer components independent of any visual
consumer. A producer declares both its inputs and outputs:

```js
{
    id: "tempo-analysis",
    needs: [FACTS.frequencyData],
    provides: [FACTS.bpm, FACTS.beat, FACTS.bandEnergy],
    process(blackboard) { /* publish current derived facts */ },
    reset(blackboard) { /* clear estimator state and owned facts */ }
}
```

Beat/BPM estimation moves out of the laser into such a producer. Laser-only effects
such as strobe cadence, smoke scheduling and canvas telemetry remain in the laser
consumer; generic beat detection and tempo estimation do not.

Each fact has at most one registered producer. Registration fails early for duplicate
providers, missing required facts or dependency cycles.

### Demand resolution and frame order

On synchronization and each relevant animation frame, the controller:

1. determines which consumers are active or still releasing;
2. unions their declared fact requirements;
3. resolves the transitive producer dependencies for those facts;
4. reads only the required raw analyzer domains;
5. runs required producers once in dependency order; and
6. draws consumers from the resulting blackboard snapshot.

A releasing consumer continues to contribute demand until its exit envelope reaches
zero. This keeps outgoing content live and avoids clearing a displayed BPM or laser
frame before its fade is visible. Once the final consumer of a producer's facts has
finished releasing, the controller stops that producer, resets its estimator state
and removes its owned facts.

If no consumer requires analyzer facts, the controller performs no
`getByteFrequencyData`, `getByteTimeDomainData` or derived tempo work. The audio
element may continue playing. An already-created Web Audio graph may remain connected
for playback, but JavaScript sampling and analysis stop. If no enabled consumer ever
requires the graph, it is not prepared merely for the BPM producer's existence.

Synthetic fallback data follows the same demand rules. A tempo producer must not
invent a metronome: without honest audio samples it publishes BPM as unavailable,
allowing the BPM display to show its unknown state and the laser to use calm mode.

### Registration and lifecycle

Consumer and producer registration happens during construction of the lazy-loaded
audio-visualization controller. Components remain registered for that controller's
lifetime. Option and station changes alter their enabled state and therefore demand;
they do not add or remove subscriptions.

This decision does not introduce a general runtime plugin marketplace API. If fully
dynamic plugin installation is required later, the controller registry can gain an
explicit rebuild or registration boundary without changing producer/consumer data
flow into listener callbacks.

## Consequences

- BPM analysis has domain ownership independent of the laser and can serve any
  number of consumers without duplicate computation.
- Analyzer reads and derived processing are demand-driven. Disabled or unavailable
  visualizations consume no analyzer CPU after their release transition.
- All consumers in one frame see the same facts, making rendering and tests
  deterministic and avoiding callback ordering or reentrancy problems.
- Adding a consumer normally means declaring `needs` and implementing `draw`; it
  does not require edits to its producers.
- Adding a derived fact means registering one producer and its dependency contract;
  consumers remain unaware of its implementation.
- The controller becomes responsible for dependency resolution, cycle validation,
  producer lifecycle and stale-fact cleanup. This is more scheduler code than a
  direct function call, but it is centralized and testable.
- Stateful estimators must define reset semantics. Their state must not leak across
  a complete loss of demand, station change or audio-source generation.
- High-frequency frame data stays inside one animation loop and one `Map`; no DOM
  events, callback fan-out or per-consumer analyzer buffers are introduced.

## Verification

Automated tests should verify:

- a producer runs exactly once per frame when one or several active consumers demand
  one of its facts;
- BPM analysis runs for the laser, the BPM display, or both, and stops after the last
  consumer finishes releasing;
- no frequency read occurs when no active consumer transitively needs frequency data;
- time-domain reads occur for oscilloscope/MilkDrop demand but not for a spectrum-only
  consumer;
- disabling one of several consumers does not reset a producer still needed by the
  others;
- the final BPM and outgoing visualization remain rendered through their opacity
  transition before facts are cleared;
- station switches, document visibility and reduced-motion changes release demand
  and reset producer state correctly;
- synthetic fallback publishes an unavailable BPM rather than a fabricated tempo;
  and
- duplicate fact providers and cyclic producer dependencies fail deterministically.

## Alternatives considered

- **Ref-counted listener/observable graph.** The first subscriber could start a
  producer and the last unsubscribe could stop it. Rejected because it introduces
  subscription cleanup, leak and double-registration risks, callback fan-out at
  frame rate, and ordering/reentrancy concerns. Native `EventTarget` also does not
  expose listener counts, so a custom broker would still be required.
- **Hybrid blackboard plus events.** Sparse lifecycle events could coexist with
  blackboard frame data. Rejected for the analyzer pipeline because current consumers
  are permanently registered render-loop components; a second communication model
  adds no necessary capability. Unrelated low-frequency player events may continue
  using their existing mechanisms.
- **Laser-owned BPM estimation.** Smallest implementation while the laser is the only
  consumer. Rejected because producer lifetime and semantic data ownership become
  coupled to one visual effect, and additional consumers either depend on the laser
  or duplicate its analysis.
- **Always-on central analyzer.** Simple and independent of consumer wiring. Rejected
  because it performs sampling and derived work when the result is unused, including
  on stations or configurations where no visualization can display it.

## Implementation status

Implemented on 2026-08-24:

- `createAudioAnalyserController` validates fact providers, resolves transitive
  demand, reads only demanded raw domains and runs each required producer once per
  frame.
- `createTempoAnalysisProducer` owns beat, energy, band and BPM estimation and
  publishes `tempo.analysis` plus `tempo.bpm`.
- Spectrum, oscilloscope, MilkDrop, laser and BPM-display consumers declare their
  facts and read the controller-local blackboard during `draw`.
- Producer demand remains active through consumer release envelopes, then resets and
  clears owned facts after the final consumer exits.
- Browser contract tests cover shared producer execution, final-consumer release,
  frequency-versus-time-domain reads, duplicate providers, missing providers and
  dependency cycles. Existing spectrum, oscilloscope, MilkDrop, laser and synthetic
  fallback tests exercise the migrated consumers.
