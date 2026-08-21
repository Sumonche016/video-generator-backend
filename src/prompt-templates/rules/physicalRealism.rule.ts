// Condensed from the CEO's original multi-paragraph physics rulebook
// (~2000 characters) — that block was the single biggest contributor to
// total prompt length, and real Veo testing showed long, checklist-style
// prompts are more likely to trip Veo's safety filter. This one-liner keeps
// the same core requirement (no object duplication/teleporting/morphing,
// believable physical continuity); Veo's own model is generally competent
// at physical plausibility without needing the full essay repeated every call.
export const PHYSICAL_REALISM_RULE = `Maintain real-world physical continuity throughout: no object duplication, teleporting, morphing, or impossible transitions — treat it as continuous live-action footage.`;
