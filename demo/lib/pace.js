// How long "Watch it play out" waits. Each caption gets time to be read before its step happens, and the result
// stays on screen long enough to see it, longer when the page refuses someone, since that's the point of the demo.

// About 200 words a minute: at least 3 seconds, at most 8.
export const readMs = text => Math.min(8000, Math.max(3000, String(text).trim().split(/\s+/).filter(Boolean).length * 300));
export const AFTER_STEP_MS = 2500;
export const AFTER_REFUSAL_MS = 4000;

// The whole story's length, for the page to say how long it takes.
export const storyMs = steps => steps.reduce((sum, step) => sum + readMs(step.say) + (step.refuse ? AFTER_REFUSAL_MS : AFTER_STEP_MS), 0);
