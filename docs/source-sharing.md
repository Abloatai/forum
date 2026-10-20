# Source release boundary

Forum is an MIT-licensed browser and Electron document application. The source supports local development with a developer’s own hosted Ablo project. Hosting the application yourself does not include or replace the hosted Ablo service. See the [README](../README.md) for setup and [source provenance](provenance.md) for adapted sources and inherited notices.

## Included and excluded

The repository includes application code, the Ablo document schema, generic authenticated API handlers, the landing page, tests, and local packaging configuration. Terraform, production deployment recipes, runtime profiles, databases, credentials, model profiles, recordings, dependency caches and generated packages are excluded. Deployment infrastructure is maintained separately and is not part of this release.

`package.json` stays `private: true` to prevent accidental npm publication; that setting does not restrict the MIT source license or GitHub repository visibility. The signed Mac preview is a separate downloadable artifact; building from source does not provide the publisher’s Apple signing identity or hosted service credentials.

## Publication checks

Run Gitleaks against all Git refs/full history and a clean tracked-source snapshot on the exact proposed public commit. Keep fully redacted reports outside Git. Also review tracked paths, provenance, commit messages and GitHub discussions for private data that a credential-pattern scanner cannot recognize. Never commit scanner reports containing findings, credentials or private verification traces.

A passing scanner checks known credential patterns; it cannot guarantee that every possible private datum is recognizable. Runtime credentials belong in ignored local configuration or the operator’s secret store. This license covers Forum source; dependency licenses and the separate hosted Ablo service still apply.
