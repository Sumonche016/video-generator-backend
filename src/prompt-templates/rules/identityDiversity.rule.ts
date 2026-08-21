// Condensed from the CEO's original full paragraph — real Veo testing
// showed very long, checklist-style prompts are more likely to trip Veo's
// safety filter. This one-liner preserves the same requirement; the scene
// description itself (see scenePlanning.template.ts) is now instructed to
// naturally reinforce it where relevant, rather than relying on this alone.
export const IDENTITY_DIVERSITY_RULE = `Every non-reference person is a distinct individual (unique face, hair, age, build, outfit) — no cloned extras or repeated faces; reference images apply only to their named character.`;
