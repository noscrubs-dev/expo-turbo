# expo_turbo-rails

The Rails package for Expo Turbo. It registers `application/vnd.expo-turbo+xml`
as the `expo_turbo` **format**, so a host writes ordinary Rails: ordinary
`respond_to`, ordinary `render`, ordinary views, and the standard `turbo-rails`
helpers. The Engine installs itself, exactly as `turbo-rails` does. The Engine
remains route-free.

The package validates every Expo Turbo response structurally before Rails
delivers it, and rejects blank or duplicate literal IDs across the complete
response, including Frame IDs. A controller must declare the components and
style tokens it may render. Its optional protected Cable boundary delegates all
credentials and resource policy to the host.

> [!IMPORTANT]
> Version [`0.2.0`](https://rubygems.org/gems/expo_turbo-rails) is the stable
> release published on 2026-08-12. Manual VoiceOver, TalkBack, and browser
> screen-reader evidence remains an explicit follow-up and is not claimed by
> the `0.2.0` compatibility surface.

```ruby
gem "expo_turbo-rails"
```

## A screen

```ruby
# app/controllers/screens_controller.rb
class ScreensController < ApplicationController
  expo_turbo_template_capabilities(manifest: Rails.root.join("config/expo_turbo_manifest.json"))

  def show
    @account = Account.find(params[:id])
  end
end
```

```erb
<%# app/views/screens/show.expo_turbo.erb %>
<Screen id="account">
  <%= turbo_frame_tag dom_id(@account, :frame) do %>
    <AccountDetails id="<%= dom_id(@account) %>" name="<%= @account.name %>" />
  <% end %>
</Screen>
```

There is no include, no view root, no `render_expo_turbo`, no route
constraint, and no second helper namespace. The action renders implicitly,
because the template exists.

To serve HTML and Expo Turbo from the same action, use `respond_to`:

```ruby
def show
  respond_to do |format|
    format.html
    format.expo_turbo
  end
end
```

`ExpoTurbo::Rails::RouteConstraint` remains available for a host that routes on
the Accept header itself, but it is no longer needed to reach the format.

## What the format changes

`expo_turbo_request?` is true only when `Accept` names
`application/vnd.expo-turbo+xml` exactly **and prefers it**: no other media
range may carry a higher quality. Every native client sends the type alone, or
beside the Turbo Stream type at equal quality. A browser wildcard, a lower
quality than `text/html`, and a malformed quality value such as `q=2` or
`q=0.5junk` are all not native.

Each standard helper takes its Expo Turbo branch from **the format Rails
selected for the render**, never from the `Accept` header on its own. A browser
may name the Expo Turbo type at a low quality while Rails renders HTML, and a
helper that disagreed with that choice would break an ordinary web page. The one
exception is a Turbo Stream response, whose media type is identical for both
audiences; there the selected format cannot separate them, and a verified native
request decides.

| Helper | Expo Turbo render | Other render |
| --- | --- | --- |
| `turbo_frame_tag` | admits the exact Frame output, and normalizes a model class to the same id on every supported `turbo-rails` version | `turbo-rails` |
| `turbo_stream` | the Expo Turbo Stream builder | `turbo-rails` |
| `turbo_stream_from` | the same signed source with the fixed `:expo` stream-name suffix | `turbo-rails` |
| `dom_id` | the shared target roles below, and a persisted record | Rails |
| `cache` | folds the Frame and module identity into the fragment key | Rails |

`dom_id(record, role)` supports the shared `record`, `document`, `frame`,
`list`, `form`, `error`, and `loading` roles. For a persisted `Account` with ID
`7` those are `account_7`, `document_account_7`, `frame_account_7`,
`list_account_7`, `form_account_7`, `error_account_7`, and `loading_account_7`.
Only `:list` accepts a model class, producing `list_account`. Every record role
requires `persisted?` plus a complete `to_key`, so an unsaved record fails
instead of collapsing into a shared `new_*` target.

## Templates and admission

An Expo Turbo template is an ordinary view named `NAME.expo_turbo.erb`, found by
ordinary lookup. The format is the confinement: lookup for this format cannot
select `.html.erb`, so no private view root or private partial resolver is
needed. This applies to Stream partials, layouts, and record partials too.

Every response whose media type is `application/vnd.expo-turbo+xml`, and every
Stream response to a request that accepts Expo Turbo, is admitted before Rails
delivers it:

- The exact output must be a strict UTF-8 XML document: one root, valid
  namespaces and attributes, no DTD or processing instruction, and an optional
  leading UTF-8 XML declaration only.
- Every literal `id` must be nonblank and unique across the complete response,
  including nested Frames.
- The capability declaration admits only its exact components and explicit
  aliases, the unprefixed `turbo-frame`, `turbo-stream`, `template`, and
  `turbo-cable-stream-source` wrappers, and declared `style-tokens`. Style-token
  lists use the same JavaScript whitespace split, count, duplicate, component,
  and group-conflict rules as the native adapter.
- A generated registry manifest also rejects undeclared component attributes and
  missing required attributes.

Validation never serializes the output, so it does not alter preserved XML text.
Set `self.expo_turbo_validate_responses = false` in one action that must deliver
a payload the protocol rejects, such as a client-behavior probe.

### Child modes

A component declares which children it accepts, and the server rejects the rest
before delivery:

| `children` | Rejected on the server |
| --- | --- |
| `nodes` | bare text |
| `text` | element children |
| `none` | any child |

Bare text under a `nodes` container is the reason this check exists. On the
device that text becomes an `RCTRawText` inside a `View`: a nonfatal RedBox in
development, and nothing at all in production. `react-test-renderer` cannot
observe it, so no client test can catch it.

Layout whitespace and comments stay valid, because the rule follows the same
`renderedTextValue` rules as the native decoder: CDATA and text under
`xml:space="preserve"` always render, and other whitespace-only text renders as
nothing.

A generated manifest carries `children` for every component. A hand-written map
declares it directly:

```ruby
expo_turbo_template_capabilities(
  components: {
    "Gallery" => {children: "nodes"},
    "DemoCard" => {children: "nodes", style_tokens: true},
    "DemoText" => {children: "text"}
  },
  max_style_tokens: 5,
  style_tokens: {
    "space:compact" => {components: ["DemoCard"], group: "space"},
    "tone:info" => {components: ["DemoCard"], group: "tone"}
  }
)
```

A hand-written map is the weakest available declaration: it validates
components, style tokens, and child modes, but no attributes. Prefer a manifest.

### Capability manifests

Keep `defineComponentDefinition` and `defineCapabilityModule` declarations in a
module that does not import native renderers, then write
`capabilityManifestJSON(capabilityModule)` to a checked-in or generated file from
plain Node or Bun, and configure the controller with `manifest:` instead of
`components:`. Component-free generation produces the same canonical JSON and
hash as `registry.capabilityManifestJSON()` without loading the host component
tree. Rails rejects a malformed or protocol-incompatible file and applies the
same validation in every environment. A manifest that predates `children` stays
readable, and its components are not child-checked. Generate the file in CI and
fail on a diff to detect a stale manifest before deployment.

## Frames

For a native Frame GET, render the matching Frame. The gem compares the
`Turbo-Frame` request header against the Frame the response actually contains,
and answers `400` when the response does not contain it. A controller cannot
know the expected Frame before the view renders, so no Frame id is written in
host code:

```ruby
def show
  head :bad_request unless expo_turbo_frame_request?
end
```

```erb
<%= turbo_frame_tag "account-details" do %>
  <AccountDetails id="account-details-content">...</AccountDetails>
<% end %>
```

Set `self.expo_turbo_frame_match = false` in one action that answers a Frame
request with a different Frame on purpose.

A `Turbo-Frame` header that is not a nonblank UTF-8 value without control
characters is rejected with `400` before the action runs. It never becomes a
document request.

`turbo_frame_tag` accepts a literal id, a record, or a model class. It delegates
tag generation to `turbo-rails` and then admits the exact output under a private
synthetic root: valid UTF-8 XML without declarations, DTDs, or processing
instructions, with every XML prefix declared by the Frame fragment itself. A
model class normalizes to Rails' `new_*` id on every supported `turbo-rails`
version, including 2.0.10, which renders the Ruby class name.

## Module version negotiation

A native client reports its installed component modules in
`X-Expo-Turbo-Modules`. `expo_turbo_client_supports?` answers whether the client
understands a module version:

```erb
<% if expo_turbo_client_supports?("noscrubs-cart", ">= 2") %>
  <CartSummary id="cart" />
<% end %>
```

**A verified native request fails closed.** Neither an absent header nor a
malformed one is evidence that a client understands a module, and both states,
an old client and a header-stripping proxy, are outside the server's control. A
request that does not accept Expo Turbo keeps the fail-open assumption, because
module gating cannot apply to it.

Every response reports the vocabulary that answered it:

| `X-Expo-Turbo-Vocabulary` | Meaning |
| --- | --- |
| `declared` | the client declared its modules |
| `assumed-none` | a native request declared nothing, so nothing is supported |
| `assumed-latest` | not a native request, so everything is assumed |

A blank module name raises rather than answering. A malformed header or entry is
logged, and that warning is not swallowed.

## Caching

Every response the Rails application produces varies on `Accept`,
`Turbo-Frame`, and `X-Expo-Turbo-Modules`. This is unconditional: a shared cache
can receive a Frame request for a URL that was first fetched as a document, and
`Accept` decides the vocabulary even when a route forced the format.

Two layers apply it, because one cannot reach every response:

- A prepended `before_action` sets it before any host filter runs, so host code
  can read and extend it during the action, and a conditional-GET `304` built
  inside the controller carries it.
- `ExpoTurbo::Rails::VaryHeaders`, Rack middleware installed immediately outside
  `ActionDispatch::ShowExceptions`, stamps it on the way out. A controller
  callback is skipped when a host filter halts the chain before the concern's
  own filter, and a response that `ActionDispatch::ShowExceptions` renders for
  an unrescued exception or an unknown route never passes through a controller
  at all.

**What is deliberately not covered.** The middleware sits inside
`ActionDispatch::Static`, `Rack::Sendfile`, and `ActionDispatch::HostAuthorization`,
so a static file, a sendfile response, a host-authorization rejection, and any
response the web server writes without entering Rails do not carry these
dimensions. That is intended: none of them is a representation of an Expo Turbo
resource, so their bytes do not change with `Accept`, `Turbo-Frame`, or the
client module versions, and adding the dimensions would only cost a shared cache
its hit rate on assets. A host that serves Expo Turbo XML from middleware above
this point must add `Vary` itself. Set
`config.expo_turbo.vary_middleware = false` to remove the middleware layer; the
controller layer then still applies, with the gaps described above.

`Vary` does not protect `Rails.cache`. Fragment cache keys of an Expo Turbo
render therefore include the same Frame and module identity, so a module-gated
fragment cannot be read back for a different client. HTML fragment keys are
unchanged.

For conditional GET, pass `expo_turbo_cache_key` to the host's existing API:

```ruby
def show
  fresh_when etag: expo_turbo_cache_key(@account, "accounts/details-v1")
end
```

The host-supplied key must include a representation version or digest that
changes with every template, partial, or layout change. `expo_turbo_vary!` and
`expo_turbo_cache_variant` are available to compose another cache API directly.
The gem does not make a response public, set a TTL, or infer tenant or user
variation.

## Streams

`render turbo_stream:` emits one or more standard Stream siblings. The builder
supports `append`, `prepend`, `before`, `after`, `replace`, `update`, `remove`,
`refresh`, and their `*_all` selector variants:

```ruby
def update
  render turbo_stream: [
    turbo_stream.update("notice", partial: "notices/notice", locals: {message: "Saved"}),
    turbo_stream.remove("new_notice")
  ]
end
```

`partial: "notices/notice"` resolves `app/views/notices/_notice.expo_turbo.erb`
and never falls back to `.html.erb`. Raw positional content, keyword `content:`,
and captured blocks are inserted as XML template payloads, so hosts must provide
valid XML. For target and selector actions, keyword `content:` is consumed as the
`<template>` payload; provide exactly one of positional content, keyword content,
a block, or a partial. A record with `to_partial_path` renders through its own
Expo Turbo partial and receives its conventional local; `layout:` accepts an Expo
Turbo layout only with a captured block. Record-compatible Stream targets use
Turbo 8.0.23's `dom_id` rules on every supported `turbo-rails` version. `refresh`
omits a blank or `false` request ID. `remove`, `remove_all`, and `refresh` have
no template and reject `content:`. Use `head :no_content` when there is no Stream
action.

For a public Action Cable stream, render the source inside an Expo Turbo
document:

```erb
<%= turbo_stream_from @room, id: "room-stream" %>
```

`turbo_stream_from` appends the fixed `:expo` suffix to the normalized
streamables. The literal streamables `:room, "42"` map to `room:42:expo`, so
native XML never arrives on the browser topic `room:42`. It emits the standard
`Turbo::StreamsChannel` descriptor with a matching signed stream name, and
reserves its channel and signature attributes.

## Broadcasts

**`broadcast_*` cannot be format-aware, and this gem does not silently override
it.** A model callback or a job has no request, so it has no format, and
`turbo-rails` renders a broadcast through `ApplicationController.render` with
`:turbo_stream` written in its own source. Overriding `broadcast_replace_to`
would send native XML to browsers, or browser HTML to native clients, with no
way for either side to tell.

Use the explicitly named API, and `expo_turbo_stream`, which stays Expo Turbo
without a request:

```ruby
broadcast_expo_turbo_stream_to @room do |stream|
  stream.append("messages", partial: "messages/message", locals: {message: @message})
end

broadcast_expo_turbo_stream_later_to @room do |stream|
  stream.append("messages", partial: "messages/message", locals: {message: @message})
end

broadcast_expo_turbo_refresh_to @room, request_id: Turbo.current_request_id, method: "morph"
broadcast_expo_turbo_refresh_later_to @room, request_id: Turbo.current_request_id, method: "morph"
```

An upstream hook would remove this limitation: if `Turbo::Broadcastable` took the
render format from its rendering options rather than fixing `:turbo_stream`, and
`Turbo::Streams::ActionBroadcastJob` carried that format through the job, a host
could broadcast once per audience through one API. Until then, a host that
serves both audiences broadcasts twice, once per API.

`broadcast_expo_turbo_stream_to` sends immediately to the host's Action Cable
pubsub. `broadcast_expo_turbo_stream_later_to` enqueues
`ExpoTurbo::Rails::Streams::BroadcastJob` with only the resolved stream name and
the already-rendered payload; it does not serialize a host model or render a
template when the job runs. The later refresh variant uses Turbo's caller-thread
debouncer for an identical resolved stream name plus request ID. The job disables
Active Job argument logging and discards an argument-deserialization failure
rather than retrying it. `ExpoTurbo::Rails::Streams.broadcast_to` remains
structural-only, because it has no host capability declaration. Do not use this
public-stream API for sensitive XML.

## Attribute whitespace

Do not put tabs or line breaks in an XML attribute with ordinary ERB
interpolation. The client XML parser replaces each raw tab, carriage return, and
line feed in an attribute value with a space before component decoding, and a
later form submission then saves the changed value. Use `expo_turbo_attribute`
for every value that can contain that whitespace:

```erb
<CustomerNotes value="<%= expo_turbo_attribute(@order.notes) %>" />
```

The helper HTML-escapes the value, then writes tabs, carriage returns, and line
feeds as `&#9;`, `&#13;`, and `&#10;`, which survive XML parsing unchanged. Use
`xml:space="preserve"` instead for multiline element text.

This shim stays opt-in. Encoding it automatically would mean replacing Rails'
own escaping (`ActionView::OutputBuffer` and `ERB::Util.unwrapped_html_escape`)
for every render, and even then it would miss attributes built by `tag.*`
helpers, which escape their own values. A response validator cannot *recover*
the original either: once an XML parser applies attribute-value normalization,
the raw whitespace is gone.

One angle remains open for a future release. The raw response body still exists
before it is parsed, so a validator that reads those bytes could reject a
literal tab, carriage return, or line feed inside an attribute value and fail
the response loudly, instead of letting the client silently collapse it. That
turns a silent data change into a server error, though it still does not encode
the value for the host. The complete fix belongs to the client parser or the
protocol.

## Protected Cable streams

For a protected resource, configure host-owned credential, subject,
authorization, and redacted callback-error hooks during application boot. Include
the connection module in the host's chosen Cable connection; it resolves and
caches the subject only when a protected subscription asks for it, and does not
add an Action Cable connection identifier.

The callback receives the included connection. Use its public
`expo_turbo_request` bridge for request headers and cookies, because Action Cable
keeps `request` private.

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

Render a protected source with a short-lived, resource-bound client-visible
grant, then publish only through the matching protected API:

```erb
<%= expo_turbo_protected_stream_from @room, grant: expo_stream_grant(@room) %>
```

```ruby
ExpoTurbo::Rails::Cable.broadcast_protected_to(
  @room,
  content: expo_turbo_stream.remove("notice").to_s
)
```

The helper renders `ExpoTurbo::Rails::Cable::ProtectedStreamsChannel`, a token
from the gem's own verifier, and `data-grant`. The Channel decodes that token to
the canonical Expo stream name only for the host authorizer, but subscribes and
broadcasts on the opaque token itself. The generic `Turbo::StreamsChannel` cannot
verify the token, so it cannot bypass the host authorizer or receive protected
broadcasts through the public `:expo` topic. Invalid descriptors, missing
subjects, invalid grants, and false authorization reject only that subscription.
Callback failures reject and send only a code and exception class to the
configured reporter; grant, credential, token, and exception message are never
passed to it.

The gem deliberately does not choose a WebSocket header, ticket encoding,
identity type, grant schema, expiry, rotation, tenant policy, or native reconnect
policy. The grant is delivered in XML and is therefore client-visible: make it
short-lived, resource-bound, and safe to send to that client. The host must
authenticate the socket, validate grant expiry and resource ownership in
`subscription_authorizer`, and recreate or reconnect the native Cable client when
identity or credentials change.

`subscription_authorizer` is evaluated when the subscription is admitted; it is
not a reauthorization lease. When a grant expires or is revoked, the host must
terminate the affected subscription or connection and require a fresh admission.

## Installation control

The Engine includes the controller concern through the `action_controller` load
hook, after `turbo-rails` installs its own helpers. To opt out and include
`ExpoTurbo::Rails::Controller` by hand:

```ruby
config.expo_turbo.include_controller = false
```

## Structural XML test helpers

Host tests can opt into strict structural XML assertions without relying on raw
string matching:

```ruby
require "expo_turbo/rails/testing"

document = ExpoTurbo::Rails::Testing.parse_document(response.body)
streams = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
  .xpath("/expo-turbo-test-root/turbo-stream")
```

`parse_document` returns a strict `Nokogiri::XML::Document` for one XML document.
`parse_stream_fragment` returns a document with a private synthetic root, so one
or more sibling `<turbo-stream>` elements retain their authored order. Both accept
only nonblank UTF-8 input, reject recovery parsing, DTDs, entity declarations,
processing instructions, malformed namespaces, and non-Stream top-level fragment
content, and never make network requests.

This entrypoint is deliberately opt-in: `require "expo_turbo/rails"` does not load
Nokogiri. It remains test support: it does not perform component, style,
duplicate-ID, or other semantic protocol validation.

Run the gem against both supported server pins with:

```sh
bundle exec appraisal ruby "$(bundle show rake)/exe/rake"
```

## Changelog

See [CHANGELOG.md](https://github.com/noscrubs-dev/expo-turbo/blob/main/CHANGELOG.md)
for release notes, breaking changes, and migrations. See the repository
[README](https://github.com/noscrubs-dev/expo-turbo#readme) for project status
and development commands.
