## Registry change type

- [ ] Native publisher submission: this PR adds exactly one
  `submissions/<publisher>/<app_id>/<version>.json` file from a
  publisher-owned fork branch.
- [ ] Hosted Web version: include the candidate source and immutable release
  record under one product, plus product.json for first admission. State the
  public slug, Web tag and requested access. Follow the hosted Web steps in
  the Registry README for the maintainer decision on this PR.
- [ ] Registry foundation change: this PR contains no submission, descriptor,
  or index mutation.
- [ ] Hosted source maintenance: pause a source or select a compatible,
  previously approved version in its source record.
- [ ] Maintainer product policy change: update the product's `kill_switch`,
  increment its revision and regenerate the affected projections. An active reason names
  the version, misstated field and actual difference, and a lift records that
  every currently distributed target version was corrected and re-reviewed and
  that old installed releases regain new launch and bind.

For native submissions, do not add an approved descriptor or edit `index.json` as a publisher. After
the publisher head passes deterministic checks and human review, a current
Registry maintainer may add the single finalization commit to this same PR.

## Publisher confirmations

- [ ] The source repository is public and the declared license texts exist at
  the resolved commit.
- [ ] The protected annotated tag resolves to the declared commit.
- [ ] The GitHub Release is immutable and every asset URL, size, and SHA-256 is
  exact.
- [ ] For a native submission, the candidate records factual native posture without treating signing as
  Nimi approval or a malware verdict.
- [ ] This PR contains no artifact bytes, secret, approval claim, or mutable
  `latest` locator.

Deterministic checks provide facts for review. They never approve the App.
