# Releasing

The monorepo publishes ten packages from one Git tag. The unscoped
`moemodels` package owns the public binary; the scoped packages remain reusable
building blocks.

> **Publishing a non-prerelease GitHub Release is the npm publish trigger.** Do
> not press **Publish release** until every npm name is reserved, trusted
> publishing is configured for the exact repository/workflow/environment, and
> the release commit has passed the checklist below. A draft GitHub Release is
> the safe place to prepare notes while setup is incomplete.

## One-time maintainer setup

1. Reserve and confirm ownership of the npm names `moemodels` and
   `@moemodels/*` before publishing any GitHub Release.
2. Create each package once if npm requires an initial interactive publication;
   do not rely on the release workflow to reserve a name.
3. Configure npm trusted publishing for repository
   `SamSnead85/moemodels`, workflow `.github/workflows/release.yml`, and GitHub
   environment `npm`.
4. Protect the `npm` environment and the `main` branch with required reviewers
   and passing CI.
5. Confirm the trusted-publisher configuration is active before publishing the
   GitHub Release; release publication triggers the workflow immediately.
6. Create a stable major Action tag such as `v0` only after verifying the
   immutable release tag it references.

No long-lived npm token belongs in the repository. The release workflow requests
an OIDC identity token and publishes with provenance.

## Release checklist

1. Update every workspace to the same version and update internal exact
   dependency versions.
2. Update user-facing version constants in the launcher, registry CLI, bench
   CLI, and Passport producer when applicable.
3. Run:

   ```sh
   npm ci
   npm test
   RELEASE_TAG=v0.1.0 node scripts/check-release-version.mjs
   npm pack --dry-run --workspaces
   ```

4. Review package contents for credentials, private endpoints, production
   configuration, and unsupported evidence claims.
5. Create and push the exact `v<version>` tag through the normal reviewed
   release process.
6. Prepare a draft GitHub Release and re-confirm package reservation and trusted
   publishing. Publishing that GitHub Release immediately triggers npm publish.
7. Verify `npx moemodels --version`, package provenance on npm, and the immutable
   release tarball digests.

The workflow intentionally does not publish prereleases. Add a separately
reviewed prerelease policy before changing that behavior.
