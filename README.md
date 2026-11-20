# Nimi App Registry

This repository is the static, Git-reviewed admission registry for public Nimi
Apps. It stores JSON metadata only. App artifacts remain in the publisher's
immutable GitHub Release.

Publisher submissions and human maintainer admission use protected branch pull
requests and required deterministic checks. Registry publication records
admission only; Catalog discovery, installation, and execution belong to their
separate Nimi Runtime and Desktop lifecycle owners.

## Remote application sources

Product identities and permanent public slugs are reviewed under `products/<app_id>/product.json`. Per-source records in `sources/<client_id>.json` produce bounded, commit-pinned Realm projections. Development sources, Android association hosts and official management sources retain their exact qualifications. A hosted Web source derives its origin from the approved slug and uses the root callback.

### Publish a hosted Web version

1. In the App repository, enable immutable Releases, protect `web-v*` against tag updates and deletion, then release `web-v<version>` using the managed workflow. Wait for the verified ZIP. The native `v*` channel has its own release and review.
2. Start a Registry PR branch from current main. For first admission, include `products/<app_id>/product.json` with the permanent slug and publisher repository identity. From the Registry root run the command below. It verifies the public asset and writes two draft records under that product. Commit those records on the PR branch. Keep the candidate JSON outside the checkout. An external publisher using a fork should allow maintainer edits on that branch.

   ```sh
   node scripts/prepare-hosted-web.mjs --product products/<app_id>/product.json --version <version> --write-draft > ../candidate.json
   ```

3. A current human maintainer reviews the product, ownership, exact source, requested access and capabilities, immutable tag, version and ZIP digest. Inspect the diff for scope. On the exact PR head, regenerate the candidate with the same command **without** `--write-draft`. Record the decision separately in `../review.json` with `decision: "approved"`, `adjudicator_login`, numeric `adjudicator_actor_id`, `reason_code` and UTC `decided_at`. Use the Registry tools from the trusted base checkout with dependencies installed. From the PR worktree run:

   ```sh
   BASE_SHA=$(gh pr view <PR> --repo nimiplatform/nimi-app-registry --json baseRefOid --jq .baseRefOid)
   node "$TOOLS/scripts/finalize-hosted-web.mjs" --product products/<app_id>/product.json --candidate ../candidate.json --review ../review.json --base "$BASE_SHA"
   node "$TOOLS/scripts/project-sources.mjs" --write
   node "$TOOLS/scripts/validate-registry.mjs" --all --schema-root "$TOOLS/schema"
   ```

   Set `TOOLS` to the trusted Registry checkout. Fetch the PR base commit if it is missing locally. The finalizer compares the two draft files with the candidate and reads the previously approved release and source revision from that commit. Push the reviewed records and generated projections to the same PR as the reviewing maintainer. Wait for `validate-registry` on that final commit, then merge. Clicking GitHub **Approve** alone leaves the release without its recorded decision.
4. After merge, the platform reconciles Registry main, checks the exact bundle and Realm source, and switches the active hosted version. Open the product at `https://nimi.ai/apps/<slug>` and use its Web launch button. DNS, storage and production credentials belong to the platform. First-use consent takes place on the user's primary PC in Nimi Home.

An ordinary content update changes the hosted version and its approved artifact, retaining the source revision. A material change in origin, callback, declarations, role or signing identity advances the source revision. A maintainer may pause an individual source, apply product policy with an independent revision, or change only `stable_version` to select a retained approved release compatible with current policy. Never reassign a public slug or client to another product.

For a pre-cutover local development file use `node scripts/migrate-local-sources.mjs <old-file> <empty-local-directory>` once, then point the non-production Realm's `RUNTIME_CLIENT_REGISTRY_PATH` at that directory.

As for native Apps, declarations may retain unknown domain names as raw input.
Runtime alone activates its supported domains for the exact registered generation;
an unknown name never grants a capability.

The `official_manager` role is a maintainer-owned qualification. It never grants
Runtime access by itself: current owner identity, a verified management session
and the PC Home's once-per-application/source confirmation remain required.
Browser or device changes do not add another permanent approval.

Android entries use `kind: android-app-link` and add `android.package_name`
and `android.certificate_sha256` (one uppercase, colon-separated SHA-256
fingerprint). The HTTPS origin is the association host, not a browser CORS
origin. Its exact same-origin callback must be declared by the signed App and
verified through the host's Digital Asset Links. Maintainer review must check
that real association; schema success or a publisher's native label is not
proof. Package/signing identity changes advance the existing source revision;
same-signature binary updates do not. The SDK/Kit native adapter checks the
installed identity and OS-verified link, while PKCE, user identity, Home source
confirmation and Runtime operation admission retain their existing owners.
Other native carriers remain unavailable. These schema/code changes create no
new approved source record by themselves.

## Ownership boundary

- A publisher-owned branch may add exactly one file below
  `submissions/<publisher>/<app_id>/<version>.json` in a candidate PR.
- Publisher input cannot contain approval, descriptor, review, or index fields.
- After deterministic checks and an explicit human decision, a current Registry
  maintainer may add one final commit to that same PR, including when that
  maintainer authored the publisher submission. The commit deletes the
  submission, adds one immutable descriptor below
  `descriptors/<app_id>/<version>.json`, and updates `index.json`. For the first native admission of a new product, the maintainer also adds its product identity and verified repository ownership.
- Automation validates facts and transitions. It never selects `approved` or
  authors a human decision.
- Existing descriptors are append-only. A new App version requires a new
  publisher Release, submission, review, and descriptor.
- A maintainer finalization changes only the admitted App's `display_name` and
  the target pointers its candidate carries (plus a new row initialized with an
  inactive kill switch at revision 0). Other rows and existing policy stay
  semantically identical; formatting or key order is not a change.
- A current maintainer changes a product's `kill_switch` in an independent
  policy pull request and increments its revision by one. Run `pnpm run project:sources`
  to include the affected Realm projections and any existing native index row in the same commit.
  This also works for a Web-only product. An active switch states a reason
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
can also use its existing authentication: without an explicit token, metadata
is read through `gh api --hostname github.com --method GET`, and credentials
stay with `gh`. A failed CLI request stops preparation rather than retrying
anonymously. It reads GitHub
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
Large transfers use bounded byte ranges, with limited retries for interrupted
transport. Every range must match its declared position and size, and the
complete package must still match the published SHA-256 before validation.

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
