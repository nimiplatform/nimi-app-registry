# Nimi App Registry

This repository is the static, Git-reviewed admission registry for public Nimi
Apps. It stores JSON metadata only. App artifacts remain in the publisher's
immutable GitHub Release.

Publisher submissions and human maintainer admission use protected branch pull
requests and required deterministic checks. Registry publication records
admission only; Catalog discovery, installation, and execution belong to their
separate Nimi Runtime and Desktop lifecycle owners.

## Ownership boundary

- A publisher-owned branch may add exactly one file below
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
- A maintainer finalization changes only the admitted App's `display_name` and
  the target pointers its candidate carries (plus a new row initialized with an
  inactive kill switch at revision 0). Other rows and existing policy stay
  semantically identical; formatting or key order is not a change.
- A base-owned maintainer policy pull request changes only `kill_switch` fields
  of existing `index.json` rows: a current maintainer, valid field ranges, and a
  revision incremented by one per changed row. It needs no candidate,
  descriptor or publisher Release download. An active switch states a reason
  naming the version, the misstated field and the actual difference, for
  example `v0.1.6 declares content_descriptors as empty; the App provides
  gambling content`; detailed grounds stay in the pull request. When the
  publisher corrects the declaration or content of every currently distributed
  target version and that release is re-reviewed, a maintainer may lift the
  switch by explicitly accepting in review that old installed releases regain
  new launch and bind; the switch stays active while an old version must
  remain blocked, past misstatement is no permanent bar, a newer version is no
  automatic lift, and `reason` is `null` while inactive. No version-level
  policy or evidence database exists.

## Publisher safety declaration

`candidate.safety_profile` is the publisher's declaration from `nimi.app.yaml`
for the exact version (audience, content descriptors, AI interaction and output
facts with current notice/marking presence, bounded data practices, high-impact
uses). Preparation reads it only from the immutable `app-info.json` Release
asset; caller input cannot supply it. It is optional in the shared
`schema_version: 1` schema so every historical descriptor stays valid as
undeclared without backfill. `schema/admission-policy.json`
(`safety_profile.required_for_new_admission`) is base-owned and switched on by
an explicit maintainer change only after supported consumers that read the
field are deployed; from then on every new publisher submission and maintainer
finalization requires the complete declaration and reports the missing field.
Transition validation prints the old-to-new declaration diff against the App's
previously admitted descriptor for review; reviewers focus on changed fields,
evident contradictions and concrete leads, reuse unchanged material, and treat
an admitted declaration as publisher-claimed fact, not Nimi certification. No
declared value (absent notices or markings, a children audience, high-impact or
commercial features) creates a global rejection by itself.

## Prepare a publisher submission

From this Registry checkout, prepare input from the publisher's actual claims
and source license paths. For example:

```json
{
  "publisher": {
    "github_namespace": "your-publisher", "namespace_kind": "organization",
    "assurance": "pseudonymous", "verified_domain_ref": null, "kyc_ref": null
  },
  "license_files": ["LICENSE"],
  "package": {
    "kind": "nimiapp", "runtime_kind": "native", "registration_mode": "app-managed",
    "sandbox_ref": "ordinary-user-process-no-sandbox"
  },
  "support": {
    "diagnostics_bundle_fields": ["app_version", "runtime_status"],
    "redaction_rules": ["credentials"], "issue_categories": ["startup", "runtime"],
    "escalation_url": "https://github.com/your-publisher/your-app/issues",
    "kill_switch_visibility": "visible", "recovery_instructions": "Restart the App from Nimi."
  },
  "update_channel": "stable", "rollback_marker": "none"
}
```

Use the actual publisher, package posture, support policy and license paths;
the example is not an approval or a license assessment. The tool derives SPDX
from the exact published App information and license digests from the tagged
source files. Input cannot supply or override remote release/asset facts or
review/admission fields.

```bash
node scripts/prepare-submission.mjs \
  --repository https://github.com/your-publisher/your-app \
  --tag v0.1.0 --input publisher-input.json --out candidate.json
```

Install the GitHub CLI (`gh`) with `attestation verify` and its source/signer
identity flags. The script uses `GH_TOKEN` or `GITHUB_TOKEN` when present; `gh`
can also use its existing authentication. It reads GitHub
metadata and exact release assets, reuses the Registry schema/fact checks and
published-candidate verifier, and cryptographically verifies SLSA build
provenance for each downloaded package against the exact repository, tag,
commit and managed `.github/workflows/nimi-app-release.yml` identity. The
verified certificate must identify a push-triggered run. GitHub's automatic
immutable-Release attestation alone is not build provenance. The script writes
only `{schema_version:1,candidate}`
after validation succeeds. The Release must be final, immutable and not a
prerelease. A different existing output is not overwritten. This can download
large `.nimiapp` packages; reuse the successful result unless inputs change.

Move the result into its canonical
`submissions/<publisher>/<app_id>/<version>.json` path for the publisher PR.
An external publisher uses its own fork; an authorized publisher sharing this
Registry namespace may use a same-repository branch. Continue the same PR for
the exact App version and Release when retrying. Human admission remains a
separate maintainer decision.

`pnpm check` validates the main-shaped static tree and rejects pending
submissions. Candidate preparation validates publisher input; the base-owned
GitHub workflow validates the exact PR transition. Do not substitute one for
the other or copy approval fields from an existing descriptor.

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
