// Lazy boundary for audio playback and its Web Audio spectrum. The controller moves
// here in the next refactoring slice; exporting its factory now makes the native
// import contract independently testable without delaying the user-gesture play().
export function createAudioSpectrumController() {
    return null;
}
