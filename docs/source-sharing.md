# Source review

Forum is prepared as a standalone Electron editor with hosted Ablo sign-in and an optional localhost development mode with a fresh source-only Git history. Runtime profiles, databases, credentials, model profiles, recordings, dependency caches and generated packages are excluded from Git. The repository remains private; no public release is implied.

Gitleaks 8.30.1 is used against all Git refs/full history and the complete tracked/unignored source snapshot, with fully redacted reports kept outside Git. Repeat that check on the exact proposed public commit. A passing scanner checks known credential patterns; it is not a guarantee that every possible private datum is recognizable.

`LICENSE.lobby` retains the inherited MIT notice. The package remains `UNLICENSED`: the owners still need to confirm redistribution rights for reused sources and choose a product license before a public release.
