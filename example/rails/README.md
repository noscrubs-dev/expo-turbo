# Rails example

This is the standalone Rails 8.1.3 API host for the public Expo Turbo suite. It owns its Gemfile and lockfile, consumes the sibling gem through `path: "../../rails"`, and has no NoScrubs dependency or product route.

The current host proves that Rails, Action Cable, `turbo-rails` 2.0.23, and the sibling gem boot together without adding gem-owned routes. Its canonical `GET /api/expo_turbo/demo/document` endpoint renders host-owned XML through the gem's opt-in controller concern; `GET /api/expo_turbo/demo/frame` requires `Turbo-Frame: demo-frame` and returns a matching XML Frame (including a `422` XML validation state); and `GET /api/expo_turbo/demo/stream` returns two standard sibling Stream actions from an XML partial and raw XML. Resettable state, Redis-backed Cable, and scenario controls land in later gates.

## Run checks

```sh
bundle install
bundle exec standardrb
bundle exec rspec
```

Start the API host with `bin/rails server -p 3001`.
