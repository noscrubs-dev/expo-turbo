# Rails example

This is the standalone Rails 8.1.3 API host for the public Expo Turbo suite. It owns its Gemfile and lockfile, consumes the sibling gem through `path: "../../rails"`, and has no NoScrubs dependency or product route.

The current scaffold proves only that Rails, Action Cable, `turbo-rails` 2.0.23, and the sibling gem boot together without adding gem-owned routes. Demo XML endpoints, resettable state, Redis-backed Cable, and scenario controls land in later gates.

## Run checks

```sh
bundle install
bundle exec standardrb
bundle exec rspec
```

Start the API host with `bin/rails server -p 3001`.
