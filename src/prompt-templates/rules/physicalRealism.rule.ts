export const PHYSICAL_REALISM_RULE = `PHYSICAL REALISM, OBJECT PERMANENCE AND TEMPORAL CONTINUITY — CRITICAL
All products, objects, people, hands, packaging, tools, furniture and environmental elements must obey real-world physics continuously across every frame.

OBJECT PERMANENCE
- Every physical object may exist in only one location at a time.
- Never duplicate, clone, teleport, spawn, ghost, or leave behind a second copy of an object after it has moved.
- If a person picks up a product from a surface, the product must completely leave that surface and exist only in the person's hands.
- Once an object moves, its previous location must remain empty.

STRUCTURAL INTEGRITY
- Treat the product as a rigid, physically connected object unless the prompt explicitly states that a component is removable, foldable, flexible, detachable, or articulating.
- Preserve the product's exact geometry, dimensions, proportions, materials, component positions, and visible structure throughout the shot.
- Do not morph, melt, stretch, shrink, bend, fade, dissolve, detach, disappear, regenerate, or change product geometry during movement.
- Components must not vanish or appear spontaneously between frames.

OCCLUSION AND SOLID SURFACES
- Solid objects are opaque and must correctly block anything behind or inside them.
- Products must never remain visible through boxes, bags, drawers, doors, walls, tables, hands, or other opaque surfaces.
- When a product enters a container, it must become progressively occluded according to its real physical position.
- Once a container is completely closed, any product fully inside must no longer be visible.
- No clipping through solid surfaces.

HAND-OBJECT CONTACT
- Hands must make believable contact with the product before lifting, carrying, rotating, opening, pressing, assembling, or moving it.
- Fingers should wrap naturally around valid grip points and must not intersect the product.
- Once held, the product and hands must move together with consistent contact.
- No floating objects, sliding through hands, disconnected grips, delayed motion, or impossible finger placement.

CAUSE AND EFFECT
Every physical interaction must follow a believable sequence.
For picking something up: approach -> hand contact -> secure grip -> lift -> original location becomes empty -> product remains only in new location.
For placing something down: carry -> align -> lower -> contact surface -> release -> hands move away -> product remains stationary.
For placing something inside packaging: open container -> align product -> lower product completely inside -> release -> hands move away -> container closes -> contents become fully occluded.

TEMPORAL CONTINUITY
- Preserve the exact state of every object from one frame to the next.
- Do not reset an object to an earlier location or orientation.
- Do not create inconsistent before/after states.
- Position, orientation, scale, lighting, contact points, and visible components should change only as physically caused by the action.

NO IMPOSSIBLE TRANSITIONS
No: duplication, teleportation, ghost copies, morphing, unexplained disappearance, spontaneous appearance, geometry changes, clipping through surfaces, impossible intersections, floating objects, incorrect occlusion, continuity resets, objects remaining behind after being picked up.

Treat the sequence like continuous live-action footage filmed in the real physical world.

SIMPLIFY RATHER THAN BREAK PHYSICS
If a requested action is too complex to maintain realistic physics and product continuity, simplify the movement or use a clean cinematic hard cut between valid physical states. Realism, product integrity, object permanence, and temporal continuity have higher priority than elaborate choreography.`;
