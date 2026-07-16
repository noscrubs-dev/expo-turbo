# Contributing

Expo Turbo is early-stage public infrastructure. Please discuss protocol or public-API changes in an issue before implementation so TypeScript, Ruby, demo, and fixture contracts stay aligned.

## Setup

```sh
bun install
bun run check

cd rails
bundle install
bundle exec rake
```

## Pull requests

- Keep the TypeScript root, Ruby gem, examples, fixtures, and docs host-neutral.
- Do not add NoScrubs application code, private hostnames, credentials, customer data, or legacy SDUI compatibility shims.
- Add behavioral tests for protocol, data-write, authorization, integration, and package-contract changes.
- Update shared fixtures atomically when a wire contract changes.
- Use a named branch; never leave public work only on a detached submodule HEAD.

All contributors must follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
