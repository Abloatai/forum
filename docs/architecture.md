# Implemented architecture

Each subsystem has an `index.ts` boundary. Electron main owns native authentication, durable drafts and a narrow transport boundary. The hosted edition sends native-only HTTPS RPC to the Forum service; explicit development mode uses a loopback Lobby bridge and its own Ablo project. A sandboxed Tiptap renderer uses a narrow preload; it has no Node access or direct network access. Main verifies the sender frame and denies navigation, webviews and permissions.

## Authority and trust

`src/auth` reuses Ablo’s RFC 8628 device flow and existing browser approval page, including workspace selection. The native process polls the issuer, validates its session and membership, then verifies the selected workspace through the Forum API. Only a verified session is saved, encrypted using Electron safeStorage. The renderer receives account display state and sign-in/out actions, never a token. Sign-out cancels login, clears encrypted session storage, closes the account’s draft database, reloads windows, and revokes the issuer session. Account-generation checks reject late responses from a previous identity.

`src/hosted/index.ts` verifies bearer sessions and current active-organization membership through hosted Ablo Auth. Its identity cache lasts at most five seconds, including verification time, fails closed after expiry, and is bounded. The native workspace header must match the issuer’s organization; a change returns 401 and requires another sign-in. Browser-origin RPC is rejected. Malformed and oversized requests are rejected, and upstream errors never expose credentials or server stacks.

`src/ablo/schema.ts` declares documents, accepted ProseMirror steps, idempotency receipts, conversation messages and agent runs. The hosted API alone holds the project credential and mints scoped Ablo actor sessions. Each workspace authority filters document lists by the verified organization and checks that organization before every document/history/metadata/chat action. Children are reachable only through an authorized document. This preview shares documents with all members of the selected organization; document-specific roles and invitations are not implemented.

Development mode is explicit: `ABLO_API_KEY` selects the developer’s project/branch, with no account-auth claim. The loopback bridge uses a random launch capability, rejects browser origins and insecure remote sockets, and bounds connections, admitted requests, payloads and buffered output. Human and agent grants permit only required Forum model operations; agents cannot create documents. A fresh model subprocess receives only a short-lived loopback MCP token and its dedicated model profile, never the project key. Its tool adapter fixes the document ID. There is no alternate SQLite document authority or production mock fallback.

## Text commits and recovery

Rich-text merging uses ProseMirror OT. A submit reads the current document through the writing Ablo client, validates and applies every step, then uses one confirmed Ablo commit for content/version, accepted steps and an operation receipt. The original captured row guards the commit. A competing edit rejects the stale premise; the client pulls accepted steps and rebases. A retried operation verifies its payload digest against its stored receipt. No stale snapshot overwrites newer content. Metadata updates also guard their captured document; agent names and paper changes check expected values and content version.

Undo/redo emits inverse ProseMirror steps through the same Ablo commit path. Ablo’s `useUndoScope` is not used: serialized rich-text arrays require position mapping rather than field-level snapshot replay. Undo history remains in memory.

Before network transmission, main synchronously stores confirmed base, pending steps and client ID in SQLite with WAL/FULL durability. Saving failure disables editing. Reconnect and restart rebase pending steps using accepted history. Hosted draft databases are scoped by endpoint, organization and verified user. Development drafts use Ablo’s returned organization/project/branch identity. Changing identities cannot upload another account’s draft; key rotation within a branch preserves recovery. Older local-only profiles are left untouched, without automatic import.

The limits are 32 bridge sockets, 16 admitted requests, 1 MiB requests, 256 steps per batch, 2 MB document JSON and a 1,000-document library. Full OT history is retained for offline rebasing; storage grows until acknowledged client horizons and compaction are implemented. Reads use bounded HTTP polling, not a rich-text CRDT or performance claim for large teams.

## Agents and chat

Messages and run records live in Ablo. Sending uses an idempotent message ID with validated sender/intent. Separate processes observe the same transcript. Each authority permits four concurrent agent runs, including several in one document. Every run has its own session, MCP token and temporary directory, with a three-minute subprocess deadline. Expired running records appear interrupted and are never automatically replayed.

Stop marks the document’s running records `stop_requested` in Ablo. Owners poll their run and terminate on stop; every mutating document tool also includes the captured running record in its atomic commit premises. A concurrent stop invalidates that premise. Already accepted edits remain. Unavailable/revoked storage can prevent the final transcript/status write; the run expires rather than fabricating completion.

The UI displays the latest 200 messages. Tool activity is grouped by agent into collapsed readable details. Agent status is above the composer; sync announcements remain available to assistive technology without a visible corner indicator. Hosted message authors use the verified account name. Presence labels are a bounded process-local observation, not global workspace presence. References do not fetch other documents or add prior chat to agent prompts.

## Presentation

The overview/sidebar use the Ablo document index. New documents open Untitled. Shared Pages/Flowing layout is independent of text version. A ResizeObserver scales pages to fit the available width and height. The Decks-derived pagination plugin converts fitted DOM measurements back to paper coordinates and preserves document positions. Flowing removes pagination and retains a white surface. Switching plugins preserves selection and undo history.

`configure_paper` validates all six finite dimensions/margins and usable content area. Invalid/stale updates preserve content and metadata. Pagination breaks between blocks; splitting a single long block across pages is not implemented.

Focused checks: `npm run check`, offline `npm test`, real-service `npm run test:integration`, native `npm run test:electron`, and `npm run test:auth`. The latter verifies the actual native gate, OS encryption, session restore, editing, restart and sign-out against explicitly simulated services; it does not establish live browser login. Native checks use synthetic data and a labeled scripted model subprocess over actual MCP tools.
