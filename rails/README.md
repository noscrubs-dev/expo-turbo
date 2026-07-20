# expo_turbo-rails

The Rails package for Expo Turbo. It registers the distinct `application/vnd.expo-turbo+xml` MIME type and provides an opt-in controller concern for rendering host-owned XML documents, matching native Frame responses, standard Turbo Stream response fragments, and immediate or queued public Stream broadcasts. The Engine remains route-free.

The package validates rendered Expo Turbo documents structurally, but does not yet validate Frame-ID uniqueness, component/style capabilities, provide protected Channels, or make a compatibility claim.

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

The template argument is relative to the configured root; absolute paths, traversal, missing files, and symlink escapes are rejected. The resolved `.xml.erb` source is evaluated as ERB with layouts disabled, rather than served as raw file content. Before it renders, the exact output must be a strict UTF-8 XML document: one root, valid namespaces and attributes, no DTD or processing instruction, and an optional leading UTF-8 XML declaration only. Validation never serializes the output, so it does not alter preserved XML text. Component vocabulary, style tokens, stable-ID/Frame-ID uniqueness, and other semantic protocol checks remain host/policy work.

For a native Frame GET, read the validated request header and emit an exact matching Frame from the host-owned XML template. `expo_turbo_frame_tag` accepts only a nonblank UTF-8 literal ID without control characters, then delegates tag generation to `turbo-rails`. It deliberately does not install `Turbo::Frames::FrameRequest`, so it does not alter HTML layouts or adopt its raw-header behavior. Before returning, it parses the exact Frame output under a private synthetic root: markup must be valid UTF-8 XML without declarations, DTDs, or processing instructions, and any XML prefix must be declared by the Frame fragment itself. Validation does not serialize or alter the returned `SafeBuffer`, so inline `xml:space="preserve"` text keeps its authored bytes for the native parser.

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

For records, use the opt-in `expo_turbo_dom_id` helper to derive literal target IDs before passing them to a Frame or Stream helper. It supports only the shared `record`, `document`, `frame`, `list`, `form`, `error`, and `loading` roles, so every role stays deterministic and distinct:

```erb
<%= expo_turbo_frame_tag expo_turbo_dom_id(@account, :frame) do %>
  <AccountDetails id="<%= expo_turbo_dom_id(@account) %>">...</AccountDetails>
<% end %>
```

For a persisted `Account` with ID `7`, those values are `account_7`, `document_account_7`, `frame_account_7`, `list_account_7`, `form_account_7`, `error_account_7`, and `loading_account_7`. Only `:list` accepts a model class, producing `list_account`; every record role requires `persisted?` plus a complete `to_key`, so unpersisted or incomplete records fail instead of producing a shared `new_*` target. Generated IDs must still be unique within each host document; the helper does not add tenant scope or accept a caller-supplied raw target segment.

`expo_turbo_frame_request?` and `expo_turbo_frame_request_id` are also available in the XML view. For an endpoint that can emit a full document or a Frame, pass `expo_turbo_cache_key` to the host's existing conditional-GET API:

```ruby
def show
  representation = expo_turbo_frame_request? ? "accounts/details-frame-v1" : "accounts/details-document-v1"
  fresh_when etag: expo_turbo_cache_key(@account, representation)
  return if performed?

  return render_expo_turbo("accounts/details") unless expo_turbo_frame_request?

  render_expo_turbo "accounts/details_frame"
end
```

The helper preserves existing `Vary` dimensions and adds `Turbo-Frame`. Its returned key distinguishes a document from each valid Frame ID, so Rails generates separate validators for representations whose bodies differ. Because Expo Turbo renders its configured XML source as inline ERB, the host-supplied key must also include a representation version or digest that changes with every template, partial, layout, or other rendered-byte change. `expo_turbo_vary_by_frame!` and `expo_turbo_cache_variant` are available when a host needs to compose another cache API directly. The gem does not make a response public, set a TTL, or infer tenant/user variation; the host must add every other representation input. Complete XML/template and duplicate-ID validation remain later work.

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

`partial: "notices/notice"` resolves only `app/views/expo_turbo/notices/_notice.xml.erb`; it never searches normal host view paths or falls back to `.html.erb`. Raw positional content, keyword `content:`, and captured blocks are inserted as XML template payloads, so hosts must provide valid XML. For target and selector actions, keyword `content:` is consumed as the `<template>` payload rather than emitted as a `<turbo-stream content>` attribute; provide exactly one of positional content, keyword content, a block, or a partial. `remove`, `remove_all`, and `refresh` have no template and reject `content:`. Each generated tag and final response is parsed as a self-contained sibling Stream fragment before it is returned; malformed XML, declarations, DTDs, processing instructions, unbound prefixes, non-Stream roots, and empty responses fail before rendering. Use `head :no_content` when there is no Stream action. The response uses `text/vnd.turbo-stream.html` and keeps multiple Stream actions as normal siblings without a custom wrapper. Record inference and layouts remain outside this API.

For a public Action Cable stream, render the source inside an Expo Turbo XML document and broadcast pre-rendered Stream markup from an explicit controller/view context:

```erb
<%= expo_turbo_stream_from @room, id: "room-stream" %>
```

```ruby
broadcast_expo_turbo_stream_to @room do |stream|
  stream.append("messages", partial: "messages/message", locals: {message: @message})
end

broadcast_expo_turbo_stream_later_to @room do |stream|
  stream.append("messages", partial: "messages/message", locals: {message: @message})
end
```

All three operations use the same normalized streamables and append the fixed `:expo` suffix. For example, the literal streamables `:room, "42"` map to `room:42:expo`, keeping Expo XML distinct from the browser HTML stream `room:42`. `expo_turbo_stream_from` emits the standard `Turbo::StreamsChannel` descriptor with a matching signed stream name and reserves its channel/signature attributes. `ExpoTurbo::Rails::Streams.broadcast_to(*streamables, content:)` is available when the host already owns a rendered nonblank UTF-8 Stream payload; it parses that payload as a self-contained sibling Stream fragment before sending or enqueueing it, and the queued job validates again before delivery.

`broadcast_expo_turbo_stream_to` sends immediately to the host's Action Cable pubsub. `broadcast_expo_turbo_stream_later_to` uses the host-configured Active Job adapter and enqueues `ExpoTurbo::Rails::Streams::BroadcastJob` with only the resolved stream-name string and already-rendered payload; it does not serialize a host model or render a template when the job runs. The job disables Active Job argument logging and discards an argument-deserialization failure rather than retrying it. The host owns Action Cable configuration (including its logger, adapter, and any mounted client endpoint) plus its Active Job adapter. This API does not establish a client connection, prove receipt, provide replay, issue credentials, or authorize protected resources. Do not use this public-stream API for sensitive XML; protected Channels and grants remain later work.

## Structural XML test helpers

Host tests can opt into strict structural XML assertions without relying on raw-string matching:

```ruby
require "expo_turbo/rails/testing"

document = ExpoTurbo::Rails::Testing.parse_document(response.body)
streams = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
  .xpath("/expo-turbo-test-root/turbo-stream")
```

`parse_document` returns a strict `Nokogiri::XML::Document` for one XML document. `parse_stream_fragment` returns a document with a private synthetic root so one or more sibling `<turbo-stream>` elements retain their authored order. Both accept only nonblank UTF-8 input (including binary HTTP bytes that validate as UTF-8), reject recovery parsing, DTDs, entity declarations, processing instructions, malformed namespaces, and non-Stream top-level fragment content, and never make network requests.

This entrypoint is deliberately opt-in: `require "expo_turbo/rails"` does not load Nokogiri. Production Frame/Stream fragments use the same strict parser lazily at their output boundaries, but this entrypoint remains test support: it does not admit complete XML document templates or perform component, style, duplicate-ID, or other semantic protocol validation.

Run the gem against both supported server pins with:

```sh
bundle exec appraisal ruby "$(bundle show rake)/exe/rake"
```

See the repository [README](../README.md) for project status and development commands.
