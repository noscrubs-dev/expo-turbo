# expo_turbo-rails

The Rails package for Expo Turbo. It registers the distinct `application/vnd.expo-turbo+xml` MIME type and provides an opt-in controller concern for rendering host-owned XML documents, matching native Frame responses, and standard Turbo Stream response fragments. The Engine remains route-free.

The package does not yet validate a whole XML document's Frame IDs, provide broadcasts/jobs/channels, or make a compatibility claim.

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

The template argument is relative to the configured root; absolute paths, traversal, missing files, and symlink escapes are rejected. The resolved `.xml.erb` source is evaluated as ERB with layouts disabled, rather than served as raw file content.

For a native Frame GET, read the validated request header and emit an exact matching Frame from the host-owned XML template. `expo_turbo_frame_tag` accepts only a nonblank UTF-8 literal ID without control characters, then delegates tag generation to `turbo-rails`. It deliberately does not install `Turbo::Frames::FrameRequest`, so it does not alter HTML layouts or ETags.

```ruby
def show
  return head :bad_request unless expo_turbo_frame_request_id == "account-details"

  render_expo_turbo "accounts/details"
end
```

```erb
<%= expo_turbo_frame_tag "account-details" do %>
  <AccountDetails id="account-details-content">...</AccountDetails>
<% end %>
```

`expo_turbo_frame_request?` and `expo_turbo_frame_request_id` are also available in the XML view. A host that varies a response by this header must set the appropriate cache variation itself; complete XML/template and duplicate-ID validation remain later work.

Use the same opt-in concern to emit one or more standard Stream siblings. The builder supports `append`, `prepend`, `before`, `after`, `replace`, `update`, `remove`, `refresh`, and their `*_all` selector variants:

```ruby
def update
  render_expo_turbo_stream(
    expo_turbo_stream.update(
      "notice",
      partial: "notices/notice",
      locals: {message: "Saved"}
    ),
    expo_turbo_stream.remove("new_notice")
  )
end
```

`partial: "notices/notice"` resolves only `app/views/expo_turbo/notices/_notice.xml.erb`; it never searches normal host view paths or falls back to `.html.erb`. Raw content and captured blocks are inserted as XML template payloads, so hosts must provide valid XML. The response uses `text/vnd.turbo-stream.html` and keeps multiple Stream actions as normal siblings without a custom wrapper. Record inference, layouts, broadcasts, jobs, and channels remain outside this API.

Run the gem against both supported server pins with:

```sh
bundle exec appraisal ruby "$(bundle show rake)/exe/rake"
```

See the repository [README](../README.md) for project status and development commands.
