// Distances shared by every hold-to-record button in the compose row (the mic
// and the video note), so the two slide and lock alike under the same thumb.

// How far the finger travels toward the start of the compose row before letting
// go discards the hold instead of sending it. Sized to the hint text: past the
// drift of a hand held up to speak, within one flick of a thumb already there.
export const CANCEL_SLIDE_DISTANCE = 110;

// Where it disarms again. Hysteresis: a single threshold flips state every time
// a resting thumb drifts across it, and each flip is a haptic and a re-render.
export const CANCEL_SLIDE_DISARM = 70;

// How far the finger lifts before a held recording becomes a hands-free one.
//
// Shorter than the cancel slide because the two must never be ambiguous: a
// diagonal drag has to resolve to one of them, and cancel is the destructive
// answer, so it takes the longer, more deliberate travel.
export const LOCK_SLIDE_DISTANCE = 64;
