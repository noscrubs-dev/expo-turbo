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
> Version [`0.3.0`](https://rubygems.org/gems/expo_turbo-rails) is the stable
> release published on 2026-08-13. Manual VoiceOver, TalkBack, and browser
> screen-reader evidence remains an explicit follow-up and is not claimed by
> the `0.3.0` compatibility surface.

```ruby
gem "expo_turbo-rails"
```

## A screen

```ruby
# app/controllers/screens_controller.rb
class ScreensController < ApplicationController
  expo_turbo_template_capabilities(
    manifest: Rails.root.join("config/expo_turbo_manifest.json"),
    lockfile: Rails.root.join("expo-turbo.lock.json")
  )

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

One action serves both audiences with no `respond_to` at all: the Accept header
picks the format and lookup picks the template, including one template written
for both. See [Sharing one template](#sharing-one-template). Use `respond_to`
when the two audiences need different work done, not merely different markup:

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
| `dom_id` | Rails | Rails |
| `cache` | folds the Frame and module identity into the fragment key | Rails |

`dom_id` is the normal Rails ActionView helper in every format. Saved records,
unsaved records, model classes, and all prefixes follow Rails. For an `Account`
with ID `7`, `dom_id(account)` is `account_7`, `dom_id(account, :frame)` is
`frame_account_7`, and `dom_id(account, :record)` is `record_account_7`. An
unsaved account and the `Account` class both use `new_account` without a prefix;
`dom_id(Account, :list)` is `list_account`.

**Migration from 0.3:** Expo Turbo renders previously treated the prefix
`:record` as no prefix, so `dom_id(account, :record)` returned `account_7`.
Change that call to `dom_id(account)` before upgrading if the old special case
was intentional. Expire cached markup or reload retained Frame/Stream targets
only for this changed ID. Other `dom_id` calls keep their Rails IDs and need no
cache or reload action.

`ExpoTurbo::Rails::DomIds.id_for` remains as a deprecated direct-call wrapper
for the 0.4 minor release. It delegates to Rails and warns on every call. Replace
it with `ActionView::RecordIdentifier.dom_id` or the standard view helper; the
wrapper will be removed in 0.5.0.

## Templates and admission

An Expo Turbo template is an ordinary view named `NAME.expo_turbo.erb`, found by
ordinary lookup, with no private view root and no private partial resolver.
This applies to Stream partials, layouts, and record partials too. Lookup tries
`expo_turbo` first and `html` behind it, so `NAME.expo_turbo.erb` always wins
over the `NAME.html.erb` beside it, and an HTML template answers when no Expo
Turbo template exists. [Sharing one template](#sharing-one-template) covers
that case.

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

## Sharing one template

One template can serve a browser and a native client. Nothing is generated and
nothing is compiled: the two vocabularies diverge in element names alone, and
ordinary lookup resolves the rest.

### Which file answers

| Files present | Browser | Native client |
| --- | --- | --- |
| `show.expo_turbo.erb` | no template | serves |
| `show.html.erb` | serves | serves, as Expo Turbo |
| both | `show.html.erb` | `show.expo_turbo.erb` |
| `show.erb` | serves | serves |

The specific format wins. Adding `show.expo_turbo.erb` beside an existing
`show.html.erb` takes over the native request and leaves the browser alone, so
a host can specialize one screen at a time and share the rest.

### The response says what the render selected

An `.html.erb` that answered a native request is an Expo Turbo representation,
not an HTML one. It is delivered as `application/vnd.expo-turbo+xml`, and the
admission rules above apply to it unchanged: a template that emits `<div>`
fails on the server instead of shipping HTML to a client that cannot read it.
The standard helpers take their Expo Turbo branch inside it too, because the
branch follows the format the render selected and not the extension of the file
that answered.

Two things can name that format, and they do not rank equally:

| Source | Example | Rank |
| --- | --- | --- |
| **demanded** by the caller | `render "page", formats: [:html]` | wins |
| **resolved** by Rails | the `Accept` header, or the `respond_to` branch that matched | otherwise |

Writing `formats:` is a decision, so it is honoured whoever asked: `render
"page", formats: [:html]` answers a native client with `text/html` and ordinary
`turbo-rails` helpers, exactly as it answers a browser. That holds for a
`NAME.erb` template too, which carries no format of its own for Rails to fall
back on. A demand covers its own render and is restored afterwards, so a helper
called after a `render_to_string ..., formats: [:html]` is already back on the
resolved format. Everything else — an implicit render, a plain `render "show"`,
a `respond_to` branch — is a resolution, and there the format Rails selected
decides. `expo_turbo_selected_format` reports the answer, and both the media
type and the helper branch read it, so the two cannot disagree.

Set `self.expo_turbo_html_template_fallback = false` on a controller to confine
its Expo Turbo renders to `.expo_turbo` templates, as releases before `0.3.0`
did. A host that would rather keep a separate tree of native views still can:
`prepend_view_path` is ordinary Rails and is unaffected.

One development-only surprise comes with it. Rails annotates `.html` templates
with `<!-- BEGIN … -->` comments when
`config.action_view.annotate_rendered_view_with_filenames` is on, which
`load_defaults` turns on in development. Those annotations now reach a native
client too. They are XML comments, which the protocol carries as comment nodes,
so the response still parses and is still admitted; the cost is that a
development response names server paths to a native client, exactly as it
already does to a browser.

### Partials

A shared `.html.erb` renders the `.html` partials beneath it, because ActionView
puts the format of the template it found at the front of lookup. A
format-neutral `NAME.erb` does not narrow lookup, so its partials still follow
the format of the request and reach `_row.expo_turbo.erb` when one exists.
Prefer `NAME.erb` for a template written to be shared, and `NAME.html.erb` when
an existing HTML view is being reused as-is.

### Element names

Every protocol wrapper is already spelled the way Turbo spells it in HTML:
`turbo-frame`, `turbo-stream`, `turbo-cable-stream-source`, and `template` need
no translation and no declaration. A component reaches its HTML name through an
alias:

```ruby
expo_turbo_template_capabilities(
  components: {
    "Text" => {aliases: ["p"], children: "text"},
    "Link" => {aliases: ["a"], children: "text"},
    "Form" => {aliases: ["form"], children: "nodes"}
  }
)
```

`<p id="hint">Pick a plan</p>` is then a paragraph to a browser and a `Text` to
a native client, and the alias carries the component's child mode, attribute
allow list, required attributes, and form ownership. Two names for one
component is the point; one name for two components raises at boot. A protocol
wrapper name cannot be aliased. Declare the same aliases on the client
component, or the server will admit a name the device cannot render.

Aliases are not required for this: no HTML element name is reserved, so a host
may name a component `a`, `form`, or `input` outright.

Rails `dom_id` is safe in a shared template. The same saved, unsaved, class, and
prefixed call returns the same ID for the browser and native client.

### What a shared template cannot use

- **Void-element helpers.** `tag.br` writes `<br>`, which is not well-formed
  XML. Rails' form builder does close its own inputs, so `text_field` and
  friends are fine; `tag.br`, `tag.hr`, and `tag.img` are not.
- **`form_with`.** It writes `accept-charset="UTF-8"`. The shared form-owner
  attributes are `action`, `enctype`, `method`, `novalidate`, and `target`,
  five of HTML's nine, and both the server and the client decoder admit exactly
  those five. A shared form writes its own element.

## The paired template lint

A host that keeps `foo.html.erb` and `foo.expo_turbo.erb` for one screen has
nothing telling it when the two drift apart. `rake expo_turbo:paired_templates`
compares every discovered pair under `app/views` and reports divergence in the
attributes that break a screen without an error: `id`, `src`, `action`,
`method`, `name`, and every `data-turbo-*`. None is confined to one element
name, so a Frame's `src`, a Stream's `method`, and a form's `action` are all
covered whatever the two sides call those elements. It also reports an element
with no counterpart, and an id-bearing element the two sides put in a different
order. Set `EXPO_TURBO_VIEW_PATHS` to lint other roots.

**It compares element to element.** Comparing the two templates' *lists* of ids
and srcs passes whenever the same values appear somewhere on both sides, which
is exactly what happens when two Frames exchange their `src` or two forms
exchange their `action`: every list matches and nothing is reported. So elements
are paired first, and each pair is compared against its own counterpart. An
element with no counterpart is reported as one.

Elements pair by `id`, which the protocol already requires unique within a
document. The id matches that appear in the same relative order on both sides
also anchor the file, so what is left pairs by document order inside the runs
between them and a difference stays in its own run. Inside a run, position
counts only when the two sides put the same number of elements there; then
every element is a position, including one carrying nothing compared, which is
what makes an attribute that moved onto a plain element visible. When the counts
differ the two sides are shaped differently — one audience needs a wrapper the
other does not, which is ordinary for a pair of templates — and the run lines up
only the elements carrying something, so a wrapper costs nothing.

**Order is a finding of its own.** Two audiences handed the same targets in a
different sequence receive different documents: another Frame navigates first,
focus lands elsewhere, a Stream applies against a different neighbour. Calling
that an attribute mismatch would name it wrongly, so it is reported as
`reordered`. Only an element carrying an `id` can be said to have moved, because
without one nothing identifies it across the two files. Relative order among
id-bearing elements is checked whatever else the two sides contain, so an
inserted wrapper cannot disturb it; absolute position is compared only when the
two sides hold the same number of elements, because otherwise an insertion and a
move are the same picture.

It reads template source and never renders, so it runs in CI with no database
and no server, and nothing in a request path loads it. Element names are not
compared, because two names for one component is what an alias is for.

`ExpoTurbo::Rails::PairedTemplates.lint(roots)` returns the same findings for a
host's own test. What it cannot detect is listed in full at the top of
`lib/expo_turbo/rails/paired_templates.rb`. Most entries follow from not
rendering: a value a helper produces, a value that differs at run time from
identical source, anything a partial or layout contributes, a branch only one
audience takes, and semantics behind equal source. Rails `dom_id` itself is
format-neutral, but the lint still cannot evaluate it or another helper. Four
limits follow from pairing rather than from rendering:

- **Nesting.** Start tags are scanned and never built into a tree, so an element
  that moved to a different parent while keeping its place in the start-tag
  order is invisible. It is the one structural difference the order check does
  not reach.
- **A reordering with no id to name it.** Only an element carrying an `id` can
  be said to have moved. Two id-less elements swapping surfaces as the attribute
  divergence it cannot be told apart from when they carry compared attributes,
  and not at all when they carry none.
- **A reordering whose relative id order is unchanged and whose two sides hold a
  different number of elements.** Absolute position is compared only when the
  counts match, because an insertion and a move are otherwise the same picture.
- **Movement of an attribute inside a run whose two sides hold a different
  number of elements**, for the same reason. An id on either element restores
  this and the one above.

In the other direction, a run whose sides hold the same number of elements but
line them up differently is compared position by position, so one structural
difference can surface as several findings; that is the same trust in position
that makes movement visible.

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

## Client compatibility

A native client sends one generated `X-Expo-Turbo-Client` descriptor. Prefer a
feature predicate over an ordered revision check:

```erb
<% if expo_turbo_client_supports_component?("CartSummary") %>
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
| `declared` | the descriptor digest resolved to a known vocabulary |
| `legacy-declared` | an installed 0.2 client sent the legacy modules header |
| `assumed-none` | a native request declared nothing, so nothing is supported |
| `assumed-latest` | not a native request, so everything is assumed |

Use `expo_turbo_client_supports_attribute?` for an attribute. The numeric
`expo_turbo_client_revision_satisfies?` helper remains an escape hatch and
compares the server-side revision for a resolved digest. The revision is not
sent by clients. The legacy `expo_turbo_client_supports?(module, requirement)`
helper reads only the 0.2 modules header. It raises for a resolved descriptor,
so a module name cannot be ignored and fail open.

This error does not appear in browser or other non-native request tests. Those
requests keep the existing fail-open web behavior, so the legacy helper returns
`true`. Before deployment, search every template for
`expo_turbo_client_supports?` and replace each descriptor-era gate. Do not use a
passing web test suite as evidence that this migration is complete.

The `lockfile:` argument is required for descriptor negotiation. Pass it with
the generated `manifest:` path, as shown in the first controller example. If a
native descriptor arrives without this configuration, the gem warns and all
feature and revision gates fail closed. An unknown digest also warns and fails
closed.

Compatibility during the 0.3 change:

| Client | Gem | Result |
| --- | --- | --- |
| 0.2 | 0.3 | the gem reads `X-Expo-Turbo-Modules` and reports `legacy-declared` |
| 0.3 | 0.2 | the old gem cannot read the descriptor and fails closed for native gates |
| 0.3 | 0.3 | the digest resolves through the lock and reports `declared` |

**Deployment order:** deploy the 0.3 gem before any 0.3 client. The 0.3 gem
continues to read the 0.2 modules header. A 0.2 gem cannot read the new
descriptor, so a 0.3 client connected to it fails all native gates closed.
The 0.3 gem also rejects any extra descriptor field while `v=1` is active. A
future client must not add a field until the deployed gem accepts it. This
strict rule is deliberate: gem-first deployment makes grammar changes explicit
and prevents an old gem from silently giving a new field the wrong meaning.

## Caching

A response can differ by `Accept`, by `Turbo-Frame`, and by the client descriptor,
so a shared cache must key on all dimensions: it can receive a Frame
request for a URL that was first fetched as a document, and `Accept` decides the
vocabulary even when a route forced the format. The gem states its `Vary`
guarantee as a boundary rather than as "every response", because one layer
cannot reach every response and a guarantee with unwritten holes is worse than a
narrower one.

Two layers apply the header:

- A prepended `before_action` sets it before any host filter runs, so host code
  can read and extend it during the action, and a conditional-GET `304` built
  inside the controller carries it.
- `ExpoTurbo::Rails::VaryHeaders`, Rack middleware installed immediately outside
  `ActionDispatch::ShowExceptions`, stamps it on the way out. A controller
  callback is skipped when a host filter halts the chain before the concern's
  own filter, and a response that `ActionDispatch::ShowExceptions` renders for
  an unrescued exception or an unknown route never passes through a controller
  at all.

### Guaranteed compatibility cache dimensions

The full value is `Vary: Accept, Turbo-Frame, X-Expo-Turbo-Client,
X-Expo-Turbo-Modules`. The last field protects the one-minor fallback for 0.2
clients and can be removed with that reader.

Every response the Rails application emits below the middleware, whatever
produced it:

- any routed controller response, including `head`, redirects, and `304`
- a response from a filter that halted the chain, including one a host
  prepended ahead of this gem's own filter
- a `rescue_from` handler's response
- a response `ActionDispatch::ShowExceptions` built for an unrescued exception
- a routing error for an unknown path

### Not covered, and why

Anything produced **above** the middleware never reaches it:

| Producer | Why it is excluded |
| --- | --- |
| `ActionDispatch::Static`, `Rack::Sendfile` | a static file's bytes do not change with these headers, and stamping them costs a shared cache its hit rate on assets |
| `ActionDispatch::HostAuthorization` | a rejected host is not a representation of any resource |
| the web server (Puma, nginx) — malformed request lines, timeouts, `502`/`504` | never enters Rails |
| a proxy or CDN that synthesizes its own response — cached error pages, WAF blocks, maintenance pages | never enters the origin at all |

None of those is a representation of an Expo Turbo resource, so none of them
varies by `Accept`, `Turbo-Frame`, or client compatibility identity.

**What a host must do.** If you cache anything from that list *and* serve Expo
Turbo XML for the same URL, add the same dimensions yourself at that layer: a
`Vary` header on the CDN rule, the static-file handler, or the proxy response.
If you serve Expo Turbo XML from middleware installed above this one, that
middleware owns its own `Vary`. Set `config.expo_turbo.vary_middleware = false`
to remove the middleware layer; the controller layer then still applies, and the
halted-filter and exception responses listed above lose the header.

`Vary` does not protect `Rails.cache`. Fragment cache keys of an Expo Turbo
render therefore include the same Frame and descriptor identity, so a gated
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
first, and `_notice.html.erb` when no Expo Turbo partial exists; that fallback is
the ordinary lookup rule and it is admitted the same way. Raw positional content,
keyword `content:`,
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
