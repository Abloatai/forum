# Source provenance

- Lobby bridge: adapted native authenticated WebSocket RPC from `Abloatai/lobby` at `1c2dc8e`, replacing its file adapter with document dispatch. Capability validation, request ordering, limits, reconnect and backpressure remain.
- Desktop: Electron/esbuild/Forge structure and isolation patterns adapted from `Abloatai/coding`. The inherited MIT notice remains in `LICENSE.lobby`.
- Editor and pagination: inspected `LuckyMonkyBaby/decks-monorepo` at `177a52bfc390cc550ae03bba8ba622406b3d5b31`. Tiptap extension composition and the presentation-only block pagination plugin are adapted from its document editor. The originally named `LuckyMonkyBaby/decks` repository was a different SDK; it was not the matching editor source.
- Document overview: follows the supplied Decks checkout’s `apps/web/src/app/(app)/[orgSlug]/docs/page.tsx` pattern of immediate Untitled creation and document cards, using the Ablo document index.
- Composer and message layout: Coding’s `components/assistant-ui/elements/thread.aui.tsx`, `components/coding/assistant/composer/matching.ts`, `references/matching.ts` and `components/coding/people/index.tsx` supply the compact composer, caret/reference matching and lower-right avatar pattern. Only supported local actions are retained. Avatars use initials; no profile photos are copied.
- Authentication: Ablo/Coding RFC 8628 device flow, server-verified membership and OS-encrypted session storage, adapted for a native-only Forum service boundary.
- Branding: Forum’s own curved-page F vector mark; the Mac icon and favicon use a black F on white. The website keeps the supplied Ablo/Lobby palette and an AI-generated outline illustration of people writing together. The illustration appears once, in the hero.

Undo/redo uses Tiptap/ProseMirror history. Decks’ Ablo `useUndoScope` mutation-history subsystem was inspected but is not integrated. Pagination converts fitted DOM coordinates back into paper units so changing window size does not change its paper geometry.

No model credentials, profiles, user documents or recordings are included. The product remains `UNLICENSED` pending the owners’ license/redistribution decision for the reused sources.
