# Nimi App Registry

This repository is the static, Git-reviewed admission registry for public Nimi
Apps. It stores JSON metadata only. App artifacts remain in the publisher's
immutable GitHub Release.

Current status: foundation development only. Public submission, admission,
Catalog discovery, installation, and execution remain unavailable until the
corresponding Nimi authority availability cutover and repository protection are
completed.

## Ownership boundary

- A publisher-owned fork branch may add exactly one file below
  `submissions/<publisher>/<app_id>/<version>.json` in a candidate PR.
- Publisher input cannot contain approval, descriptor, review, or index fields.
- After deterministic checks and an explicit human decision, a current Registry
  maintainer may add one final commit to that same PR, including when that
  maintainer authored the publisher submission. The commit deletes the
  submission, adds one immutable descriptor below
  `descriptors/<app_id>/<version>.json`, and updates `index.json`.
- Automation validates facts and transitions. It never selects `approved` or
  authors a human decision.
- Existing descriptors are append-only. A new App version requires a new
  publisher Release, submission, review, and descriptor.

## Local validation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm check
```

`pnpm check` validates the checked-out static tree. Pull-request transition
validation is performed by the base-owned GitHub workflow so untrusted fork
code is never executed with repository credentials.

No artifact bytes, private publication state, mutable `latest` download URL,
malware verdict, check ledger, or Runtime/Desktop lifecycle state belongs here.
