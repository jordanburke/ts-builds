# Release Process

[![npm version](https://img.shields.io/npm/v/ts-builds.svg)](https://www.npmjs.com/package/ts-builds)

This package uses **npm trusted publishers** for secure, tokenless publishing from GitHub Actions.

## Dependency Updates (No Automatic Release)

Releases are **manual and tag-based only**. `publish.yml` runs only when a `v*` tag is pushed.

When Dependabot updates dependencies:

1. Dependabot opens a PR
2. CI validates it (`pnpm validate`)
3. `auto-merge-dependabot.yml` approves and auto-merges patch and minor updates
4. The update lands on `main` **unreleased**

Major updates are not auto-merged. To ship merged updates, cut a manual release (below).

## Manual Releases

For new features or breaking changes:

```bash
# Patch release (bug fixes)
npm version patch -m "fix: description"
git push --follow-tags

# Minor release (new features)
npm version minor -m "feat: description"
git push --follow-tags

# Major release (breaking changes)
npm version major -m "feat!: description"
git push --follow-tags
```

The tag push triggers the publish workflow automatically.

Push the tag from a local or PAT credential. A tag pushed by GitHub Actions' `GITHUB_TOKEN`
does **not** trigger `publish.yml` (GitHub's recursion guard), so an automated bump-and-tag
would never publish.

## What Happens on Release

1. **Validation**: Runs `pnpm validate` (format, build, test)
2. **Publish**: Publishes to npm with provenance
3. **GitHub Release**: Creates release with auto-generated notes

## Authentication

This package uses [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) (OIDC) instead of tokens:

- No `NPM_TOKEN` secret needed
- Authentication tied to GitHub repo/workflow
- Configured at: npmjs.com → package settings → Publishing access

## Troubleshooting

### Publish fails with 404

- Verify trusted publisher config on npmjs.com matches:
  - Repository owner: `jordanburke`
  - Repository name: `ts-builds`
  - Workflow filename: `publish.yml`
  - Environment: _(blank)_

### GitHub release fails with 403

- Check `contents: write` permission in `.github/workflows/publish.yml`

### npm version compatibility

- The workflow does not update npm. It uses the npm bundled with the Node version in `.nvmrc`.
- `.nvmrc` pins an exact Node version (`24.20.0`, bundling npm 11.19.0), not a bare major.
  A bare `24` lets `actions/setup-node` pick whichever 24.x the runner has cached, and some
  bundled npm versions break the OIDC exchange.

### Publish fails with E401 "Failed to generate Web Auth URLs"

- npm abandoned the OIDC token exchange and fell back to interactive login. This is an npm
  version problem, not a credential problem.
- Check the Node/npm version in the publish log against `.nvmrc`, and keep `.nvmrc` pinned
  to an exact version known to publish.
