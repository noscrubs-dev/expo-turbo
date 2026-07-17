# expo-turbo

Turbo-compatible XML, Frames, Streams, and Action Cable adapters for Expo React Native and Rails.

> [!IMPORTANT]
> This repository currently exposes foundational contracts only. It does not yet implement or claim Turbo compatibility, and no published package should be used in an application.

## Repository layout

- `src/` — public TypeScript package source.
- `rails/` — public `expo_turbo-rails` gem and non-route-owning Rails Engine.
- `example/expo/` — standalone native consumer and future compatibility gallery.
- `example/rails/` — standalone Rails and Action Cable host.
- `protocol/` — shared protocol manifest and conformance fixtures.
- `docs/` — public architecture, compatibility, and release guidance.

The repository root is the publishable TypeScript package. It is intentionally not a package-manager workspace; both example applications keep independent dependency state.

## Development

The TypeScript scaffold requires Bun 1.3.14 or newer:

```sh
bun install
bun run check
```

The Ruby scaffold requires Ruby 3.2 or newer:

```sh
cd rails
bundle install
bundle exec ruby "$(bundle show rake)/exe/rake"
bundle exec ruby "$(bundle show rake)/exe/rake" build
```

Install each example independently, then run both checks from the repository root:

```sh
cd example/expo && bun install --frozen-lockfile
cd ../rails && bundle install
cd ../..
bun run examples:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing changes.

## TypeScript API boundaries

The root package and explicit `expo-turbo/core` and `expo-turbo/adapters` subpaths expose the current version, error, inspector, and host-adapter contracts. `expo-turbo/react`, `expo-turbo/registry`, and `expo-turbo/testing` are reserved module boundaries and intentionally export no runtime APIs yet. Deep source imports are unsupported.

The adapter surface is host-neutral. Core source does not import Expo Router, an Action Cable client, an app API client, or private application hooks.

## Status and compatibility

The intended baseline is Turbo 8.0.23, Rails/Action Cable 8.1.3, and `turbo-rails` 2.0.23, with the gem also testing `turbo-rails` 2.0.10 compatibility. Those targets are planning constraints until the public conformance suite proves them.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
