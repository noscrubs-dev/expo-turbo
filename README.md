# expo-turbo

Turbo-compatible XML, Frames, Streams, and Action Cable adapters for Expo React Native and Rails.

> [!IMPORTANT]
> This repository is currently a buildable scaffold. It does not yet implement or claim Turbo compatibility, and no published package should be used in an application.

## Repository layout

- `src/` — public TypeScript package source.
- `rails/` — public `expo_turbo-rails` gem and non-route-owning Rails Engine.
- `example/expo/` — future standalone native compatibility gallery.
- `example/rails/` — future standalone Rails and Action Cable host.
- `protocol/` — shared protocol manifest and conformance fixtures.
- `docs/` — public architecture, compatibility, and release guidance.

The repository root is the publishable TypeScript package. It is intentionally not a package-manager workspace; both example applications will keep independent dependency state.

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
bundle exec rake
gem build expo_turbo-rails.gemspec
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing changes.

## Status and compatibility

The intended baseline is Turbo 8.0.23, Rails/Action Cable 8.1.3, and `turbo-rails` 2.0.23, with the gem also testing `turbo-rails` 2.0.10 compatibility. Those targets are planning constraints until the public conformance suite proves them.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
