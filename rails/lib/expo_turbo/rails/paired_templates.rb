# frozen_string_literal: true

module ExpoTurbo
  module Rails
    # A lint over a `foo.html.erb` / `foo.expo_turbo.erb` pair. A host that
    # keeps two templates for one screen has no compiler telling it when they
    # drift, and the drift that matters is not visual: an id the client
    # targets, the Frame a request navigates, where a form posts and how, the
    # names a controller reads out of params, and the Turbo behavior
    # attributes. This reports exactly those.
    #
    # It reads template source and never renders. Nothing here runs during a
    # request; the module is autoloaded and its only entry points are the rake
    # task and a host's own test.
    #
    # Element names are deliberately not compared. Serving both audiences from
    # two templates is what aliases are for, so `<p>` opposite `<DemoText>` is
    # the expected shape, not a finding.
    #
    # What it cannot detect, because it never renders:
    #
    # - A value a helper produces. `<%= form_with %>`, `<%= link_to %>`, and
    #   `<%= turbo_frame_tag %>` are opaque; their action, href, ids, and
    #   control names are invisible here.
    # - A value that differs at run time from identical source. `dom_id` is
    #   itself format-aware, so the same `<%= dom_id(post, :frame) %>` on both
    #   sides can still produce two different ids.
    # - Anything a partial, a layout, or a helper module contributes. Only the
    #   two paired files are read, and a partial pair is linted as its own
    #   pair, against its own counterpart.
    # - A branch that only one audience takes. `<% %>` control flow is
    #   stripped, so every branch of a conditional is read as if taken; a
    #   template that branches on `expo_turbo_request?` reports the markup of
    #   both branches.
    # - Semantics behind equal source: two `method="post"` forms that post to
    #   different places through different routes agree here. The reverse
    #   costs a false report rather than a miss: an expression is compared as
    #   text after whitespace runs collapse, so `dom_id( post )` and
    #   `dom_id(post)` are reported as two values.
    # - An implicit default. An HTML `<form>` with no `method` is a GET; a
    #   component that requires the attribute is not. Absent is compared with
    #   absent, not with the default it stands for.
    # - Any screen whose two templates are not a discovered pair, including a
    #   single shared template, which has nothing to diverge from.
    module PairedTemplates
      EXPRESSION_OPEN = "«"
      EXPRESSION_CLOSE = "»"
      EXPO_TURBO_FORMAT = "expo_turbo"
      HTML_FORMAT = "html"
      FRAME_ELEMENT = "turbo-frame"

      ASPECT_LABELS = {
        control_name: "control name",
        data_turbo: "Turbo data attribute",
        form_action: "form action",
        form_method: "form method",
        frame_src: "Frame src",
        id: "id",
        unreadable: "unreadable template"
      }.freeze

      ERB_TAG = /<%(={1,2}|-|\#|%)?(.*?)-?%>/m
      ELEMENT = /<([A-Za-z_][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/m
      ATTRIBUTE = /([^\s=\/>"'][^\s=\/>]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/
      TEMPLATE_NAME = /\A(?<logical>.+)\.(?<format>#{HTML_FORMAT}|#{EXPO_TURBO_FORMAT})\.(?<handler>[^.]+)\z/

      Pair = Struct.new(:name, :html_path, :expo_turbo_path)

      Finding = Struct.new(:aspect, :value, :path, :line, :counterpart_path) do
        def to_s
          label = ASPECT_LABELS.fetch(aspect)
          return "#{path}:#{line}: #{label}" if aspect == :unreadable

          "#{path}:#{line}: #{label} #{value.inspect} has no counterpart in #{counterpart_path}"
        end
      end

      module_function

      # What the rake task lints when a host names no roots. Empty outside a
      # Rails application, so the linter stays usable as a plain object.
      def default_roots
        return [] unless defined?(::Rails) && ::Rails.respond_to?(:root) && ::Rails.root

        [::Rails.root.join("app/views").to_s]
      end

      # Every discovered pair under the given roots, sorted by logical name so
      # a CI report reads the same way twice.
      def pairs(*roots)
        found = {}
        roots.flatten.each do |root|
          root = root.to_s
          next unless File.directory?(root)

          Dir.glob("**/*.*.*", base: root).sort.each do |relative|
            match = TEMPLATE_NAME.match(File.basename(relative))
            next unless match && File.file?(File.join(root, relative))

            name = File.join(File.dirname(relative), match[:logical]).delete_prefix("./")
            entry = found[name] ||= Pair.new(name, nil, nil)
            path = File.join(root, relative)
            if match[:format] == HTML_FORMAT
              entry.html_path ||= path
            else
              entry.expo_turbo_path ||= path
            end
          end
        end
        found.values.select { |pair| pair.html_path && pair.expo_turbo_path }.sort_by(&:name)
      end

      def lint(*roots)
        pairs(*roots).flat_map { |pair| lint_pair(pair) }
      end

      def lint_pair(pair)
        html = read(pair.html_path)
        expo_turbo = read(pair.expo_turbo_path)
        unreadable = []
        unreadable << Finding.new(:unreadable, nil, pair.html_path, 1, pair.expo_turbo_path) if html.nil?
        unreadable << Finding.new(:unreadable, nil, pair.expo_turbo_path, 1, pair.html_path) if expo_turbo.nil?
        return unreadable if unreadable.any?

        html_values = extract(html)
        expo_turbo_values = extract(expo_turbo)
        ASPECT_LABELS.each_key.flat_map do |aspect|
          next [] if aspect == :unreadable

          missing(html_values[aspect], expo_turbo_values[aspect], pair.html_path, pair.expo_turbo_path) +
            missing(expo_turbo_values[aspect], html_values[aspect], pair.expo_turbo_path, pair.html_path)
        end
      end

      # A multiset difference, so a value written twice on one side and once on
      # the other is reported once.
      def missing(entries, counterparts, path, counterpart_path)
        remaining = counterparts.map(&:first).tally
        entries.filter_map do |value, line, aspect|
          count = remaining[value]
          if count&.positive?
            remaining[value] = count - 1
            next
          end

          Finding.new(aspect, value, path, line, counterpart_path)
        end
      end

      def read(path)
        source = File.binread(path).force_encoding(Encoding::UTF_8)
        source.valid_encoding? ? source : nil
      rescue SystemCallError
        nil
      end

      # Values are collected as [value, line, aspect] so a finding can name the
      # line it came from. Substituting ERB moves every later offset, so
      # normalize returns the map back to the file on disk rather than padding
      # the replacement, which would put newlines inside attribute values.
      def extract(source)
        values = ASPECT_LABELS.each_key.to_h { |aspect| [aspect, []] }
        normalized, offsets = normalize(source)
        normalized.scan(ELEMENT) do
          element = Regexp.last_match
          line = source[0, source_offset(offsets, element.begin(0))].count("\n") + 1
          attributes = parse_attributes(element[2])
          collect(values, element[1], attributes, line)
        end
        values
      end

      def source_offset(offsets, index)
        segment = offsets.reverse_each.find { |start, _, _| start <= index }
        return index unless segment

        start, origin, verbatim = segment
        verbatim ? origin + (index - start) : origin
      end

      def collect(values, name, attributes, line)
        values[:id] << [attributes["id"], line, :id] if attributes.key?("id")
        values[:frame_src] << [attributes["src"], line, :frame_src] if name == FRAME_ELEMENT && attributes.key?("src")
        values[:control_name] << [attributes["name"], line, :control_name] if attributes.key?("name")
        # A form owner is the element that carries `action`, whatever it is
        # called, so an aliased form is compared with the HTML one.
        if attributes.key?("action")
          values[:form_action] << [attributes["action"], line, :form_action]
          values[:form_method] << [attributes["method"], line, :form_method] if attributes.key?("method")
        end
        attributes.each do |attribute, value|
          values[:data_turbo] << ["#{attribute}=#{value}", line, :data_turbo] if attribute.start_with?("data-turbo")
        end
      end

      def parse_attributes(source)
        source.to_s.scan(ATTRIBUTE).to_h do |name, double, single, bare|
          [name, double || single || bare || ""]
        end
      end

      # `<%= %>` becomes an opaque token so an expression can be compared as
      # written; `<% %>` and `<%# %>` leave nothing behind. Returns the
      # normalized source and the segments that map it back to the original:
      # [normalized offset, source offset, copied verbatim].
      def normalize(source)
        normalized = +""
        segments = []
        cursor = 0
        source.scan(ERB_TAG) do
          tag = Regexp.last_match
          segments << [normalized.length, cursor, true]
          normalized << source[cursor...tag.begin(0)]
          segments << [normalized.length, tag.begin(0), false]
          normalized << replacement(tag[1], tag[2].to_s)
          cursor = tag.end(0)
        end
        segments << [normalized.length, cursor, true]
        normalized << source[cursor..].to_s
        [normalized, segments]
      end

      def replacement(marker, body)
        return "" unless marker == "=" || marker == "=="

        "#{EXPRESSION_OPEN}#{body.strip.gsub(/\s+/, " ")}#{EXPRESSION_CLOSE}"
      end

      private_class_method :lint_pair, :missing, :read, :extract, :source_offset, :collect, :parse_attributes,
        :normalize, :replacement
    end
  end
end
