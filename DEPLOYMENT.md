# Automatic deployment

Repository: https://github.com/CodeDuckky/bark-worker

Production Worker: `bark-worker`. The production branch is `master`.

Cloudflare Workers Builds is the deployment owner. Pushes and merges to
`master` first run `npm run check` and then `npx wrangler deploy`.
The repository root is `/`, Node.js is pinned to 22 in `.node-version`, and
non-production branch builds are disabled.

GitHub Actions runs the same checks on pushes and pull requests, without a
second deployment job. Dependabot checks npm dependencies and GitHub Actions
weekly and opens PRs. Updates require review and a merge; no auto-merge is set.

Bark keeps the existing `database` D1 binding and database `database_bark`. Builds do not create databases, run schema migrations, or send push notifications. Tests use local isolated D1.

## Local checks

```sh
npm ci
npm run check
```

## Rollback

Restore a prior deployment in the existing Worker's Cloudflare Deployments
page, then revert the problem change on `master` to align the source.
Pre-automation deployment version: `4df62c9f-47d4-4018-b925-13bb680dbb1a`.

This change configures CI and deployment; it does not change application logic.
