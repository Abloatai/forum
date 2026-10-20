<p align="center">
  <a href="https://forum.abloatai.com"><img src="assets/banner.svg" alt="Forum" width="480" /></a>
</p>

<p align="center">
  <strong>A shared place to write, with people and agents.</strong>
</p>

<p align="center">
  <a href="https://forum.abloatai.com/app/">Open Forum</a> &nbsp;|&nbsp;
  <a href="https://forum.abloatai.com">Download for Mac</a> &nbsp;|&nbsp;
  <a href="#run-locally">Run locally</a> &nbsp;|&nbsp;
  <a href="docs/architecture.md">Docs</a>
</p>

---

Forum is a multiplayer document editor for the browser and desktop, built with
[Tiptap](https://tiptap.dev) and [Ablo](https://github.com/Abloatai/ablo).
Write together, talk beside the document, and let agents work in the same text.

- **Write together.** People and agents share documents and conversation across the workspace.
- **Make room for the work.** Choose paper pages or a flowing document, with shared paper sizes and margins.
- **Bring your models.** Hosted agents support Anthropic or a model gateway; local agents use an installed Codex executable.
- **Keep your place.** Pending edits stay on your device and recover after a disconnect or restart.

[Open Forum](https://forum.abloatai.com/app/) with your Ablo account, or
[download the Apple Silicon Mac preview](https://forum.abloatai.com).
The preview has no automatic updater yet.

## How edits stay in sync

Human editors rebase ProseMirror steps using operational transformation (OT).
Agent tools read a version, then commit through Ablo with captured-read guards;
stale edits are rejected so the agent can reread and retry. Document content,
steps and retry receipts commit together. This is OT with optimistic concurrency,
not a CRDT or an exclusive document lock.

## Run locally

Use **Node.js 24 or later** and your own **hosted Ablo development project**.
Create a separate project for Forum; applying its schema to an existing
application project can affect that application's data model.

```sh
git clone https://github.com/Abloatai/forum.git
cd forum
npm ci
npx --package @abloatai/cli@0.66.16 ablo login --project YOUR_PROJECT
npx --package @abloatai/cli@0.66.16 ablo dev --branch forum-local --schema src/ablo/schema.ts --no-watch
npm start
```

`ablo dev` prepares the branch and writes its temporary key to ignored
`.env.local`. Follow the CLI's data-plane readiness instructions if prompted;
rerun `ablo dev` when the key expires. Developers on the same Ablo branch share
the same documents and chat.

**You can host the Forum application yourself. Ablo always stays hosted.**
No Ablo backend, service credentials or production deployment infrastructure
are included. Without a development key, the app uses Forum's hosted sign-in.

## Agents

Use `/agent` to work with an agent, `/model` to choose an available model, and
`/team` to send a message to people. Agent edits use the same document authority
as human edits. Stale edits must reread before retrying; stopping an agent keeps
changes already accepted.

See [agent setup and local operation](docs/operations.md) for local executable
configuration, and [architecture](docs/architecture.md#agents-and-chat) for
hosted provider configuration and limits.

## Development

```sh
npm run check
npm test
npm run build
```

The default tests use labeled service doubles and skip the live Ablo check
unless a project key is exported. Real-service checks write synthetic records:
use a disposable branch. See [verification and recovery](docs/operations.md)
for browser, Electron and live-agent checks. `npm run make` packages the Mac app;
publisher signing credentials are separate.

## Contributing

[Open an issue](https://github.com/Abloatai/forum/issues) or send a pull request.
The current preview shares documents across a workspace; invitation controls
and document-specific permissions are not implemented yet.

## License

[MIT](LICENSE). See [source provenance](docs/provenance.md) for adapted sources
and inherited notices. Dependencies retain their own licenses; the hosted Ablo
service is separate.
