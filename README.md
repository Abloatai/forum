# Forum

A multiplayer document editor for the browser and Mac, built with Tiptap and hosted Ablo. People in the same Ablo workspace share documents and chat. Local drafts keep pending edits safe. The application can also run locally with your own Ablo project.

## Mac app

Open [Forum](https://forum.abloatai.com/app/) in your browser to reuse your Ablo session, or download the Apple Silicon preview. The updated native sign-in screen offers **Continue with Google** and **Continue with email**. Google returns through a secure browser-to-app handoff; email uses a six-digit code. This flow requires the Forum frontend and callback scheme to be registered with hosted Ablo Auth. Forum stores native sessions encrypted with the OS keychain and restores them after restart. Project keys are never bundled or requested by this edition.

## Run from source

Use Node 24 and a supported desktop OS. Create/select a **separate development project** in Ablo; do not point the Forum schema at an existing application project. Prepare its development branch with the Ablo CLI:

```sh
npm ci
npx --package @abloatai/cli@0.66.16 ablo login --project YOUR_PROJECT
npx --package @abloatai/cli@0.66.16 ablo dev --branch forum-local --schema src/ablo/schema.ts --no-watch
npm start
```

`ablo dev` writes the temporary branch key into ignored `.env.local`. The project must have its Ablo data plane ready for this schema; follow the CLI’s readiness instructions if necessary. Forum always uses hosted Ablo; the document application is what runs locally or on infrastructure you control. No Ablo backend is bundled. The app keeps the key and short-lived human/agent sessions in its native process; neither renderer nor model subprocess receives them. Rotate an expired branch key by rerunning `ablo dev`.

Two developers connecting the same development branch see the same documents and conversation. Each runs their own local application. Never share keys in chat or commit `.env.local`.

Without `ABLO_API_KEY`, the native app uses the hosted sign-in flow. For a self-hosted Forum API, `FORUM_API_URL` selects its HTTPS origin (loopback HTTP is accepted for local development). The identity authority and data service remain hosted Ablo. `src/hosted/index.ts` owns account validation and workspace isolation; deployment infrastructure is intentionally maintained separately.

The document overview and collapsible sidebar organize your work. The new-document icon opens **Untitled** immediately. Start the app again to open another window. Choose **Pages** or **Flowing** in the formatting toolbar. Pages fit the window; both modes keep a white text surface. Paper size and margins are shared document settings.

The composer supports `/agent`, `/team`, `/model`, `@` participant references and `#` document references. References are text only. Agent activity is expandable; status sits above the composer. Disconnect and restart recovery happen automatically.

## Optional local agent

Set `LOBBY_DOCS_AGENT_COMMAND` and `LOBBY_DOCS_AGENT_HOME` in `.env.local` to absolute paths for an installed Codex executable and a dedicated, provisioned profile. No profile or credentials are included. `/model` uses that executable’s model catalog. Agents can edit text, name documents and configure paper. Multiple agents can work on one document, with up to four runs per application instance. Stale edits must reread before retrying. **Stop agents** stops the document’s active runs and retains accepted edits.

Tests use an explicitly labeled **Scripted test agent** over real MCP tools. Live model execution remains unverified. Rich-text undo/redo uses ProseMirror history and commits through Ablo; it is not Decks’ `useUndoScope` and does not survive app restarts.

## Check and package

```sh
npm run check
npm test
npm run test:integration
npm run test:electron
npm run test:auth
npm run test:browser
npm run test:site
npm run make
```

`npm test` runs unit checks with a clearly labeled in-memory authority contract double and skips the live SDK check unless `ABLO_API_KEY` is exported. `test:integration` and `test:electron` load `.env.local` and require a disposable development branch. They create synthetic documents and chat records there. On headless Linux, use `xvfb-run -a` for Electron. Forge produces a Mac ZIP. Publisher-provided signing identity and OS-keychain notarization profile enable signed, notarized builds without putting Apple credentials in source. The preview targets macOS Apple Silicon; automatic updates and Windows are not implemented.

[Architecture](docs/architecture.md), [local recovery](docs/operations.md), [source provenance](docs/provenance.md), [source review](docs/source-sharing.md).
