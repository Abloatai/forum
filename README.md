<p align="center">
  <a href="https://forum.abloatai.com"><img src="assets/banner.svg" alt="Forum" width="480" /></a>
</p>

<p align="center">
  <a href="https://forum.abloatai.com/app/">Open Forum</a> &nbsp;|&nbsp;
  <a href="https://forum.abloatai.com">Download for Mac</a> &nbsp;|&nbsp;
  <a href="#run-locally">Run locally</a> &nbsp;|&nbsp;
  <a href="docs/architecture.md">Docs</a>
</p>

Forum is a document editor where people and agents can write at the same time.
It runs in your browser or as a Mac app.

Documents and chat are shared across your Ablo workspace. Write on pages or in
a continuous document, with the conversation beside it.

[Tiptap](https://tiptap.dev) handles the editor.
[Ablo](https://github.com/Abloatai/ablo) stores the documents, edits and chat.
Human edits merge through ProseMirror OT. Agents read the document before
editing; if someone changes it in the meantime, Ablo rejects the stale write
and the agent has to read it again before retrying.

## Run locally

You need Node.js 24 or later and an Ablo development project. Create a separate
project for Forum so its schema doesn't affect another application.

```sh
git clone https://github.com/Abloatai/forum.git
cd forum
npm ci
npx --package @abloatai/cli@0.66.16 ablo login --project YOUR_PROJECT
npx --package @abloatai/cli@0.66.16 ablo dev --branch forum-local --schema src/ablo/schema.ts --no-watch
npm start
```

Follow any setup instructions from the CLI. It writes the branch key to ignored
`.env.local`; rerun `ablo dev` when that key expires. Connect to the same branch
to work on the same documents.

You can run Forum locally or host the application yourself. It connects to
hosted Ablo in both cases. Starting without a development key opens the hosted
sign-in flow.

## Agents

Type `/agent` to ask an agent, `/model` to change models, or `/team` to send a
message to people. You can stop agents while keeping the edits they've made.

On hosted Forum, connect your own ChatGPT/Codex account during required first-time setup. Manage the connection later under Account → Codex account.
Agent requests use your plan. You can also run a local Codex executable; provider
adapters remain available for explicit server setups. See [the operations doc](docs/operations.md).

## Development

```sh
npm run check
npm run test:coverage
npm run build
```

The Node coverage report measures source loaded by that test run. Browser and
Mac checks run separately. The default tests use simulated services. A live Ablo test also runs if
`ABLO_API_KEY` is exported; use a disposable branch. The
[operations doc](docs/operations.md#live-collaboration-verification) covers real
model checks and the browser and Electron tests. Run `npm run make` to package
the Mac app.

## Status

This is a preview. The Mac download is for Apple Silicon and has no automatic
updater. Invite collaborators from Members, then copy a document link with Share.
Everyone in a workspace can access its documents; there are no per-document permissions.

[Issues and feedback](https://github.com/Abloatai/forum/issues) are welcome.

## License

[MIT](LICENSE). See [source provenance](docs/provenance.md) for inherited code
and dependency notices.
