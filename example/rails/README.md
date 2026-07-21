# Rails example

This is the standalone Rails 8.1.3 API host for the public Expo Turbo suite. It owns its Gemfile and lockfile, consumes the sibling gem through `path: "../../rails"`, and has no NoScrubs dependency or product route.

The current host proves that Rails, Redis-backed Action Cable, `turbo-rails` 2.0.23, and the sibling gem boot together without adding gem-owned routes. Its canonical `GET /api/expo_turbo/demo/document` endpoint renders host-owned XML through the gem's opt-in controller concern and a signed public `demo-stream` source; `GET /api/expo_turbo/demo/frame` requires `Turbo-Frame: demo-frame` and returns a matching XML Frame (including a `422` XML validation state); `GET` and `POST /api/expo_turbo/demo/form` require `Turbo-Frame: demo-form-frame`, accept one bounded URL-encoded `profile[first_name]` value, return server-owned matching `422` XML for invalid input, and redirect valid submissions with `303` to the canonical Frame GET; `GET /api/expo_turbo/demo/stream` returns two standard sibling Stream actions from an XML partial and raw XML; and local development/test only `POST /api/expo_turbo/demo/broadcast` emits one public Expo XML `replace` to `demo-stream`. The request suite subscribes to that Expo namespace through the real Redis adapter, proves exactly one XML Stream delivery, and verifies that an unqualified `demo-stream` subscription receives nothing. Separate desktop CI smokes submit the form through the public core controls and fetch adapter, and fetch the document, open the real `/cable` endpoint through the public adapter/registry, wait for Action Cable confirmation, post the local broadcast, observe the XML replacement, then emit an exact unsubscribe command and close. Development preserves Action Cable's localhost browser-origin rule and permits a headerless native WebSocket handshake; production receives neither that exception nor the broadcast route. Protected Cable delivery, resettable state, and broader scenario controls remain later work.

## Run checks

```sh
bundle install
bundle exec standardrb
bundle exec rspec
```

Ensure Redis is running first. It defaults to `redis://localhost:6379/1` for development and `redis://localhost:6379/15` for tests; set `REDIS_URL` to override either. Start the API host with `bin/rails server -p 3001`.
