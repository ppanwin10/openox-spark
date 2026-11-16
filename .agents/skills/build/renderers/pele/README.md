# Pele resource owner

These typed files are the only local changes to pinned upstream Pele1.6.0.
`upstream.json` pins the complete original build inputs; unchanged inputs and
the upstream browser build are verified before regeneration. The original build
also typechecks the complete upstream source, separately from `.agents`.

In an owned checkout of the pinned commit with its declared build dependencies,
run `bun .agents/skills/build/scripts/pele.ts --source=<checkout>`.
Normal `bun run build` verifies the typed-owner and generated-resource hashes.
Never edit `Pele.bundle/pele.js` directly.
