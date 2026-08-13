# frozen_string_literal: true

module ExpoTurbo
  module Rails
    # A lint over a `foo.html.erb` / `foo.expo_turbo.erb` pair. A host that
    # keeps two templates for one screen has no compiler telling it when they
    # drift, and the drift that matters is not visual: an id the client
    # targets, the Frame a request navigates, where a form posts and how, the
    # names a controller reads out of params, and the Turbo behavior
    # attributes.
    #
    # It compares ELEMENT TO ELEMENT, not value list to value list. Comparing
    # the two templates' sets of ids, srcs and actions passes whenever the
    # values are the same somewhere, which is exactly what happens when two
    # Frames exchange their src or two forms exchange their action: every set
    # matches and nothing is reported. So elements are paired first and each
    # pair's attributes are compared against its own counterpart.
    #
    # Elements pair by `id`, which the protocol already requires to be unique
    # within a document, and whatever is left over pairs by document order.
    # Only elements carrying at least one compared attribute are recorded, so
    # an untracked wrapper cannot shift the ordering of the ones that matter.
    #
    # It reads template source and never renders. Nothing here runs during a
    # request; the module is autoloaded and its only entry points are the rake
    # task and a host's own test.
    #
    # Element names are deliberately not compared. Serving both audiences from
    # two templates is what aliases are for, so `<p>` opposite `<DemoText>` is
    # the expected shape, not a finding.
    #
    # What it cannot detect:
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
    # - Where an element sits. Start tags are scanned, not nested, so an
    #   element that moved to a different parent still pairs by its id and
    #   reports nothing.
    # - Two elements that exchanged their ids AND every compared attribute
    #   together. Nothing distinguishes them once element names are out of
    #   scope, which they are by design.
    # - Semantics behind equal source: two `method="post"` forms that post to
    #   different places through different routes agree here. The reverse costs
    #   a false report rather than a miss: an expression is compared as text
    #   after whitespace runs collapse, so `dom_id( post )` and `dom_id(post)`
    #   are reported as two values.
    # - An implicit default. An HTML `<form>` with no `method` is a GET; a
    #   component that requires the attribute is not. Absent is compared with
    #   absent, not with the default it stands for.
    # - Any screen whose two templates are not a discovered pair, including a
    #   single shared template, which has nothing to diverge from.
    #
    # Pairing id-less elements by document order over-reports rather than
    # under-reports: one extra id-less element on a side shifts the rest, so a
    # single edit can surface as several findings. Giving elements ids removes
    # the ambiguity.
    module PairedTemplates
      EXPRESSION_OPEN = "«"
      EXPRESSION_CLOSE = "»"
      EXPO_TURBO_FORMAT = "expo_turbo"
      HTML_FORMAT = "html"
      # `src` is Frame navigation, `action` and `method` are form owners and
      # Stream actions, `name` is a control the server reads out of params.
      # None is confined to one element name, because a shared screen spells
      # its components differently on each side.
      TRACKED_ATTRIBUTES = %w[action id method name src].freeze
      TURBO_DATA_PREFIX = "data-turbo"

      ASPECT_LABELS = {
        action: "action",
        data_turbo: "Turbo data attribute",
        element: "element",
        id: "id",
        method: "method",
        name: "control name",
        src: "src",
        unreadable: "unreadable template"
      }.freeze

      ERB_TAG = /<%(={1,2}|-|\#|%)?(.*?)-?%>/m
      ELEMENT = /<([A-Za-z_][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/m
      ATTRIBUTE = /([^\s=\/>"'][^\s=\/>]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/
      TEMPLATE_NAME = /\A(?<logical>.+)\.(?<format>#{HTML_FORMAT}|#{EXPO_TURBO_FORMAT})\.(?<handler>[^.]+)\z/

      Pair = Struct.new(:name, :html_path, :expo_turbo_path)

      Element = Struct.new(:line, :attributes) do
        def id
          value = attributes["id"]
          (value.nil? || value.empty?) ? nil : value
        end

        # What a reader needs to find this element in the file.
        def label
          return "##{id}" if id

          described = attributes.first
          described ? "the element with #{described.first}=#{described.last.inspect}" : "an element"
        end

        def summary
          attributes.map { |name, value| "#{name}=#{value.inspect}" }.join(" ")
        end
      end

      Finding = Struct.new(:aspect, :element, :value, :counterpart_value, :path, :line, :counterpart_path) do
        def to_s
          "#{path}:#{line}: #{detail}"
        end

        private

        def detail
          case aspect
          when :unreadable then ASPECT_LABELS.fetch(:unreadable)
          when :element then "#{element} (#{value}) has no counterpart in #{counterpart_path}"
          else
            label = ASPECT_LABELS.fetch(aspect)
            return "#{element} #{label} #{value.inspect} is absent in #{counterpart_path}" if counterpart_value.nil?

            "#{element} #{label} #{value.inspect} does not match #{counterpart_value.inspect} in #{counterpart_path}"
          end
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
        unreadable << Finding.new(:unreadable, nil, nil, nil, pair.html_path, 1, pair.expo_turbo_path) if html.nil?
        unreadable << Finding.new(:unreadable, nil, nil, nil, pair.expo_turbo_path, 1, pair.html_path) if expo_turbo.nil?
        return unreadable if unreadable.any?

        correspond(extract(html), extract(expo_turbo))
          .flat_map { |left, right| compare(left, right, pair.html_path, pair.expo_turbo_path) }
          .sort_by { |finding| [finding.path, finding.line, finding.aspect.to_s, finding.value.to_s] }
      end

      # Pair by id first, because an id is the document's own identity and the
      # protocol requires it unique. Whatever is left pairs by document order,
      # which still catches an id that differs between the two sides. A pair
      # may be half empty; that is an element with no counterpart.
      def correspond(left_elements, right_elements)
        pairs = []
        available = {}
        right_elements.each_with_index do |element, index|
          next unless element.id

          (available[element.id] ||= []) << index
        end

        taken = {}
        unmatched_left = []
        left_elements.each do |element|
          index = element.id ? available[element.id]&.shift : nil
          if index
            taken[index] = true
            pairs << [element, right_elements[index]]
          else
            unmatched_left << element
          end
        end

        unmatched_right = right_elements.each_with_index.reject { |_, index| taken[index] }.map(&:first)
        [unmatched_left.length, unmatched_right.length].max.times do |index|
          pairs << [unmatched_left[index], unmatched_right[index]]
        end
        pairs
      end

      def compare(left, right, left_path, right_path)
        return [Finding.new(:element, left.label, left.summary, nil, left_path, left.line, right_path)] if right.nil?
        return [Finding.new(:element, right.label, right.summary, nil, right_path, right.line, left_path)] if left.nil?

        (left.attributes.keys | right.attributes.keys).sort.filter_map do |name|
          left_value = left.attributes[name]
          right_value = right.attributes[name]
          next if left_value == right_value

          if left_value.nil?
            Finding.new(aspect_for(name), right.label, right_value, nil, right_path, right.line, left_path)
          else
            Finding.new(aspect_for(name), left.label, left_value, right_value, left_path, left.line, right_path)
          end
        end
      end

      def aspect_for(name)
        name.start_with?(TURBO_DATA_PREFIX) ? :data_turbo : name.to_sym
      end

      def read(path)
        source = File.binread(path).force_encoding(Encoding::UTF_8)
        source.valid_encoding? ? source : nil
      rescue SystemCallError
        nil
      end

      # Substituting ERB moves every later offset, so normalize returns the map
      # back to the file on disk rather than padding the replacement, which
      # would put newlines inside attribute values.
      def extract(source)
        elements = []
        normalized, offsets = normalize(source)
        normalized.scan(ELEMENT) do
          match = Regexp.last_match
          attributes = tracked(parse_attributes(match[2]))
          next if attributes.empty?

          line = source[0, source_offset(offsets, match.begin(0))].count("\n") + 1
          elements << Element.new(line, attributes)
        end
        elements
      end

      def tracked(attributes)
        attributes.select do |name, _|
          TRACKED_ATTRIBUTES.include?(name) || name.start_with?(TURBO_DATA_PREFIX)
        end
      end

      def source_offset(offsets, index)
        segment = offsets.reverse_each.find { |start, _, _| start <= index }
        return index unless segment

        start, origin, verbatim = segment
        verbatim ? origin + (index - start) : origin
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

      private_class_method :lint_pair, :correspond, :compare, :aspect_for, :read, :extract, :tracked,
        :source_offset, :parse_attributes, :normalize, :replacement
    end
  end
end
