## Registry change type

- [ ] Publisher submission: this PR adds exactly one
  `submissions/<publisher>/<app_id>/<version>.json` file from a
  publisher-owned fork branch.
- [ ] Registry foundation change: this PR contains no submission, descriptor,
  or index mutation.
- [ ] Maintainer policy change: this PR changes only `kill_switch` fields of
  existing `index.json` rows with incremented revisions; an active reason names
  the version, misstated field and actual difference, and a lift records that
  every currently distributed target version was corrected and re-reviewed and
  that old installed releases regain new launch and bind.

Do not add an approved descriptor or edit `index.json` as a publisher. After
the publisher head passes deterministic checks and human review, a current
Registry maintainer may add the single finalization commit to this same PR.

## Publisher confirmations

- [ ] The source repository is public and the declared license texts exist at
  the resolved commit.
- [ ] The protected annotated tag resolves to the declared commit.
- [ ] The GitHub Release is immutable and every asset URL, size, and SHA-256 is
  exact.
- [ ] The candidate records factual native posture without treating signing as
  Nimi approval or a malware verdict.
- [ ] This PR contains no artifact bytes, secret, approval claim, or mutable
  `latest` locator.

Deterministic checks provide facts for review. They never approve the App.
