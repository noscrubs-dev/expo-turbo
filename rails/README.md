# expo_turbo-rails

The Rails package for Expo Turbo. It registers the distinct `application/vnd.expo-turbo+xml` MIME type and provides an opt-in controller concern for rendering host-owned `.xml.erb` views. The Engine remains route-free.

The package does not yet provide Frames, Stream helpers, broadcasts, jobs, channels, or a compatibility claim.

```ruby
gem "expo_turbo-rails"
```

```ruby
require "expo_turbo/rails"
```

Opt a controller into XML rendering and confine it to one host-owned view root:

```ruby
class ExpoTurboController < ActionController::API
  include ExpoTurbo::Rails::Controller

  expo_turbo_view_root Rails.root.join("app/views/expo_turbo")

  def show
    render_expo_turbo "documents/show"
  end
end
```

The template argument is relative to the configured root; absolute paths, traversal, missing files, and symlink escapes are rejected.

Run the gem against both supported server pins with:

```sh
bundle exec appraisal ruby "$(bundle show rake)/exe/rake"
```

See the repository [README](../README.md) for project status and development commands.
