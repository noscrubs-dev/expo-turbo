# expo_turbo-rails

The Rails package for Expo Turbo. It registers the distinct `application/vnd.expo-turbo+xml` MIME type and provides an opt-in controller concern for rendering host-owned XML documents, matching native Frame responses, standard Turbo Stream response fragments, and immediate or queued public Stream broadcasts. Use `ExpoTurbo::Rails::Controller` rather than including its helper modules directly. The Engine remains route-free.

The package validates rendered Expo Turbo documents structurally and rejects blank or duplicate literal IDs across the complete response, including Frame IDs. A controller must declare the components and style tokens it is allowed to render documents; when it does, the same policy also applies to its Frame, Stream, and raw controller-broadcast output. Its optional protected Cable boundary delegates all credentials and resource policy to the host.

> [!IMPORTANT]
> Version [`0.2.0`](https://rubygems.org/gems/expo_turbo-rails) is the stable
> release published on 2026-08-12. Manual VoiceOver, TalkBack, and browser
> screen-reader evidence remains an explicit follow-up and is not claimed by
> the `0.2.0` compatibility surface.

```ruby
gem "expo_turbo-rails"
```

```ruby
require "expo_turbo/rails"
```

Use the Accept-header route constraint when Expo Turbo and another format share a route family:

```ruby
constraints ExpoTurbo::Rails::RouteConstraint.new do
  get "screens/:step", to: "turbo/documents#show"
end
```

The constraint matches the registered Expo Turbo MIME type and positive `application/*` or `*/*` wildcards. A `q=0` value on the most-specific matching media range rejects the request, even when a less-specific wildcard has a positive quality. Missing, blank, unrelated, and substring-only Accept values do not match.

Opt a controller into XML rendering and confine it to one host-owned view root:

```ruby
class ExpoTurboController < ActionController::API
  include ExpoTurbo::Rails::Controller

  expo_turbo_view_root Rails.root.join("app/views/expo_turbo")
  expo_turbo_template_capabilities(
    components: {
      "Gallery" => {},
      "DemoCard" => {style_tokens: true},
      "DemoText" => {}
    },
    max_style_tokens: 5,
    style_tokens: {
      "space:compact" => {components: ["DemoCard"], group: "space"},
      "tone:info" => {components: ["DemoCard"], group: "tone"}
    }
  )

  def show
    render_expo_turbo "documents/show"
  end
end
```

The template argument is relative to the configured root; absolute paths, traversal, missing files, and symlink escapes are rejected. The resolved `.xml.erb` source is evaluated as ERB with layouts disabled, rather than served as raw file content. Before it renders, the exact output must be a strict UTF-8 XML document: one root, valid namespaces and attributes, no DTD or processing instruction, and an optional leading UTF-8 XML declaration only. Every literal `id` must also be nonblank and unique across the complete rendered document, including nested Frames. The capability declaration then admits only its exact components (and explicit aliases), exact unprefixed `turbo-frame`, `turbo-stream`, `template`, and `turbo-cable-stream-source` wrappers (including default-namespace elements), and declared `style-tokens`. Style-token lists use the same JavaScript whitespace split, count, duplicate, component, and group-conflict rules as the native adapter. A component must opt into the `style-tokens` attribute, and style-token component lists are canonicalized through aliases. A generated registry manifest also rejects undeclared component attributes and missing required attributes. Shared protocol attributes such as `id`, `class`, `data-*`, and `xml:space` stay available. Components with `formOwner: true` also admit the form protocol attributes `action`, `enctype`, `method`, `novalidate`, and `target` without declaring them as component props. The host declaration must mirror its installed registry and style adapter. Attribute values still receive their full codec and Zod validation on the client. Validation never serializes the output, so it does not alter preserved XML text.

Do not put multiline values in XML attributes with ordinary ERB interpolation. The client XML parser changes raw tabs and line breaks in an attribute to spaces before component decoding. A later form submission can then save the changed value. Use `expo_turbo_attribute` for each value that can contain this whitespace:

```erb
<CustomerNotes value="<%= expo_turbo_attribute(@order.notes) %>" />
```

The helper first HTML-escapes the value. It then writes tabs, carriage returns, and line feeds as `&#9;`, `&#13;`, and `&#10;`. The character references preserve the original value through XML parsing. Use `xml:space="preserve"` instead for multiline element text.

The client registry can replace the hand-written component map. Keep
`defineComponentDefinition` and `defineCapabilityModule` declarations in a
module that does not import native renderers, then write
`capabilityManifestJSON(capabilityModule)` to a checked-in or generated file
from plain Node or Bun. Bind each definition to its React Native renderer with
`bindComponent` only in the runtime module. Configure the controller with
`manifest:` instead of `components:`:

```ruby
expo_turbo_template_capabilities(
  manifest: Rails.root.join("config/expo_turbo_manifest.json"),
  max_style_tokens: 5,
  style_tokens: {
    "space:compact" => {components: ["DemoCard"], group: "space"},
    "tone:info" => {components: ["DemoCard"], group: "tone"}
  }
)
```

The versioned manifest contains the registry modules, component tags and aliases, and each component attribute's name and requiredness. Component-free generation produces the same canonical JSON and hash as `registry.capabilityManifestJSON()` without loading the host component tree. Rails loads it when the controller is configured, rejects a malformed or protocol-incompatible file, derives `style-tokens` support from the declared attribute, and applies the same component and attribute validation in every environment. Name-only attributes from a 0.1.4 manifest remain readable and are treated as optional. Generate the file in CI and fail on a diff to detect a stale manifest before deployment.

For a native Frame GET, read the validated request header and emit an exact matching Frame from the host-owned XML template. `expo_turbo_frame_tag` accepts a nonblank UTF-8 literal ID without control characters, or a model class that it normalizes with Rails' `dom_id`, then delegates tag generation to `turbo-rails`. It deliberately does not install `Turbo::Frames::FrameRequest`, so it does not alter HTML layouts or adopt its raw-header behavior. Before returning, it parses the exact Frame output under a private synthetic root and applies the same configured component/style admission: markup must be valid UTF-8 XML without declarations, DTDs, or processing instructions, and any XML prefix must be declared by the Frame fragment itself. Validation does not serialize or alter the returned `SafeBuffer`, so inline `xml:space="preserve"` text keeps its authored bytes for the native parser.

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

The helper preserves existing `Vary` dimensions and adds `Turbo-Frame` and `X-Expo-Turbo-Modules`. Its returned key distinguishes a document from each valid Frame ID and each reported module-version set, so Rails generates separate validators for representations whose bodies differ. Because Expo Turbo renders its configured XML source as inline ERB, the host-supplied key must also include a representation version or digest that changes with every template, partial, layout, or other rendered-byte change. `expo_turbo_vary_by_frame!` and `expo_turbo_cache_variant` are available when a host needs to compose another cache API directly. The gem does not make a response public, set a TTL, or infer tenant/user variation; the host must add every other representation input.

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

`partial: "notices/notice"` resolves only `app/views/expo_turbo/notices/_notice.xml.erb`; it never searches normal host view paths or falls back to `.html.erb`. Raw positional content, keyword `content:`, and captured blocks are inserted as XML template payloads, so hosts must provide valid XML. For target and selector actions, keyword `content:` is consumed as the `<template>` payload rather than emitted as a `<turbo-stream content>` attribute; provide exactly one of positional content, keyword content, a block, or a partial. A record with `to_partial_path` is rendered through the same confined XML partial resolver and receives its conventional local; `layout:` accepts the same XML partial path only with a captured block. A positional renderable must implement `render_in`, declare `format: :xml`, and receives a limited context that exposes only `render(partial:, locals:)` plus `capture`; its partial render is likewise confined to the Expo XML root. These boundaries prevent ordinary lookup from selecting host HTML, but templates and renderables remain trusted host code rather than a Ruby sandbox. Record-compatible Stream targets use Turbo 8.0.23's `dom_id` rules on every supported `turbo-rails` version: a record becomes its `dom_id`, a bare model class becomes `new_*`, and a selector gets the corresponding `#` prefix; raw string IDs and selectors remain unchanged. `refresh` omits a blank or `false` request ID while preserving all other attributes. `remove`, `remove_all`, and `refresh` have no template and reject `content:`. Each generated tag and final response is parsed as a self-contained sibling Stream fragment before it is returned; output built through the configured controller also receives the same component/style admission. Use `head :no_content` when there is no Stream action. The response uses `text/vnd.turbo-stream.html` and keeps multiple Stream actions as normal siblings without a custom wrapper.

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

broadcast_expo_turbo_refresh_to @room, request_id: Turbo.current_request_id, method: "morph", scroll: "preserve"
broadcast_expo_turbo_refresh_later_to @room, request_id: Turbo.current_request_id, method: "morph", scroll: "preserve"
```

All three operations use the same normalized streamables and append the fixed `:expo` suffix. For example, the literal streamables `:room, "42"` map to `room:42:expo`, keeping Expo XML distinct from the browser HTML stream `room:42`. `expo_turbo_stream_from` emits the standard `Turbo::StreamsChannel` descriptor with a matching signed stream name and reserves its channel/signature attributes. `ExpoTurbo::Rails::Streams.broadcast_to(*streamables, content:)` is available when the host already owns a rendered nonblank UTF-8 Stream payload; it parses that payload as a self-contained sibling Stream fragment before sending or enqueueing it, and the queued job validates again before delivery.

`broadcast_expo_turbo_stream_to` sends immediately to the host's Action Cable pubsub. `broadcast_expo_turbo_stream_later_to` uses the host-configured Active Job adapter and enqueues `ExpoTurbo::Rails::Streams::BroadcastJob` with only the resolved stream-name string and already-rendered payload; it does not serialize a host model or render a template when the job runs. The dedicated refresh variants build and validate their tag before sending or deferring it. The later variant uses Turbo's caller-thread debouncer for an identical resolved Expo stream name plus request ID, so repeated refreshes on that thread collapse to the newest pre-rendered XML while different streams or request IDs remain independent. It does not coordinate across threads or processes. The job disables Active Job argument logging and discards an argument-deserialization failure rather than retrying it. Context-free `ExpoTurbo::Rails::Streams.broadcast_to` remains structural-only because it has no host capability declaration; render a payload through a configured controller before sending when component/style admission is required. The host owns Action Cable configuration (including its logger, adapter, and any mounted client endpoint) plus its Active Job adapter. This API does not establish a client connection, prove receipt, provide replay, issue credentials, or authorize protected resources. Do not use this public-stream API for sensitive XML.

## Protected Cable streams

For a protected resource, configure host-owned credential, subject, authorization, and redacted callback-error hooks during application boot. Include the connection module in the host's chosen Cable connection; it resolves and caches the subject only when a protected subscription asks for it, and does not add an Action Cable connection identifier.

The callback receives the included connection. Use its public `expo_turbo_request` bridge for request headers/cookies because Action Cable keeps `request` private.

```ruby
ExpoTurbo::Rails::Cable.configure(
  credential_extractor: ->(connection) {
    host_extract_short_lived_credential(connection.expo_turbo_request)
  },
  subject_resolver: ->(credential) { host_resolve_subject(credential) },
  subscription_authorizer: ->(subject:, stream_name:, grant:) {
    host_authorize_expo_stream(subject:, stream_name:, grant:)
  },
  subscription_error_reporter: ->(code:, error_class:) {
    host_report_expo_turbo_cable_error(code:, error_class:)
  }
)

class ApplicationCable::Connection < ActionCable::Connection::Base
  include ExpoTurbo::Rails::Cable::Connection
end
```

Render a protected source with a short-lived, resource-bound client-visible grant, then publish only through the matching protected API:

```erb
<%= expo_turbo_protected_stream_from @room, grant: expo_stream_grant(@room) %>
```

```ruby
ExpoTurbo::Rails::Cable.broadcast_protected_to(
  @room,
  content: expo_turbo_stream.remove("notice").to_s
)
```

The helper renders `ExpoTurbo::Rails::Cable::ProtectedStreamsChannel`, a token from the gem's own verifier, and `data-grant`. The Channel decodes that token to the canonical Expo stream name only for the host authorizer, but subscribes and broadcasts on the opaque token itself. The generic `Turbo::StreamsChannel` cannot verify the token, so it cannot bypass the host authorizer or receive protected broadcasts through the public `:expo` topic. Invalid descriptors, missing subjects, invalid grants, and false authorization reject only that subscription. Callback failures reject and send only a code and exception class to the configured reporter; grant, credential, token, and exception message are never passed to it.

The gem deliberately does not choose a WebSocket header, ticket encoding, identity type, grant schema, expiry, rotation, tenant policy, or native reconnect policy. The grant is delivered in XML and is therefore client-visible: make it short-lived, resource-bound, and safe to send to that client. The host must authenticate the socket, validate grant expiry and resource ownership in `subscription_authorizer`, and recreate/reconnect the native Cable client when identity or credentials change.

`subscription_authorizer` is evaluated when the subscription is admitted; it is not a reauthorization lease. When a grant expires or is revoked, the host must terminate the affected subscription or connection and require a fresh admission. If targeted disconnect is needed, the host may use its own safe Action Cable connection identity or channel mechanism; this gem intentionally adds no connection identifier.

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

## Changelog

**2026-07-21**:

- Changed: Added an opt-in protected Cable source, Channel, verifier namespace, and immediate/queued broadcast APIs.
- Why: Public Turbo stream signatures cannot carry host resource authorization safely.
- Impact: Protected hosts must configure the four callbacks above and terminate affected subscriptions or connections after grant expiry/revocation; public stream behavior remains unchanged.

See the repository
[README](https://github.com/noscrubs-dev/expo-turbo#readme) for project status
and development commands.
