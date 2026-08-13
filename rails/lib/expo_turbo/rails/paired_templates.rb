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
    # within a document. The id matches that appear in the same relative order
    # on both sides also anchor the file: what is left pairs by document order
    # inside the runs between them, so a difference is contained to its own run.
    #
    # Inside a run, position means something only when the two sides put the
    # same number of elements there. Then every element counts as a position,
    # including one carrying nothing this compares, which is what makes an
    # attribute that moved onto a plain element visible. When the counts differ
    # the two sides are shaped differently, which for a pair of templates is
    # ordinary rather than wrong: one audience needs a wrapper the other does
    # not. The run then lines up only the elements that carry something to
    # compare, so a wrapper costs nothing.
    #
    # Order is checked as well, and reported as its own kind rather than forced
    # into an attribute mismatch, because it is a different thing: two
    # audiences handed the same targets in a different sequence receive
    # different documents, whatever the attributes say. See #reorderings.
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
    # - Nesting. Start tags are scanned and never built into a tree, so an
    #   element that moved to a different parent while keeping its place in the
    #   start-tag order is invisible. This is the one structural difference the
    #   order check above does not reach.
    # - A reordering with no id to name it. Only an element carrying an id can
    #   be said to have moved, because without one nothing identifies it across
    #   the two files. Two id-less elements swapping surfaces as the attribute
    #   divergence it is indistinguishable from when they carry compared
    #   attributes, and not at all when they carry none.
    # - A reordering whose relative id order is unchanged and whose two sides
    #   hold a different number of elements. Absolute position is compared only
    #   when the counts match, because an insertion and a move are otherwise the
    #   same picture.
    # - Movement of an attribute inside a run whose two sides hold a different
    #   number of elements, for the same reason: that run compares only the
    #   elements carrying something, so an attribute that moved onto a plain one
    #   there is invisible. An id on either element restores this and the one
    #   above.
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
    # Where it over-reports: a run whose two sides hold the same number of
    # elements but line them up differently is compared position by position,
    # so one structural difference can surface as several findings. That is the
    # same trust in position that makes movement visible, so it is deliberate.
    # Giving elements ids removes the ambiguity in both directions.
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
        reordered: "reordered",
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
          when :reordered
            "#{element} is at position #{value} here and position #{counterpart_value} in #{counterpart_path}"
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

        left_elements = extract(html)
        right_elements = extract(expo_turbo)
        attribute_findings = correspond(left_elements, right_elements)
          .flat_map { |left, right| compare(left, right, pair.html_path, pair.expo_turbo_path) }
        order_findings = reorderings(left_elements, right_elements, pair.html_path, pair.expo_turbo_path)

        (attribute_findings + order_findings)
          .sort_by { |finding| [finding.path, finding.line, finding.aspect.to_s, finding.value.to_s] }
      end

      # Order is a divergence of its own. Two audiences handed the same targets
      # in a different sequence receive different documents: a different Frame
      # navigates first, focus lands elsewhere, a Stream applies against a
      # different neighbour. Reporting that as an attribute mismatch would name
      # it wrongly, so it is its own finding.
      #
      # Only an element carrying an id can be said to have moved, because
      # without one there is nothing that identifies it across the two files;
      # two id-less elements swapping is indistinguishable from their
      # attributes changing, and compare already reports that.
      #
      # Two questions are asked, and the second needs a guard the first does
      # not. Relative order among id-bearing elements holds whatever else the
      # two sides contain, so an inserted wrapper cannot disturb it. Absolute
      # position is compared only when the two sides hold the same number of
      # elements, because otherwise an insertion and a move look exactly alike
      # and silence is the safe reading of the two.
      def reorderings(left_elements, right_elements, left_path, right_path)
        matches = id_matches(left_elements, right_elements)
        comparable_positions = left_elements.length == right_elements.length
        out_of_order = {}
        highest = -1
        matches.keys.sort.each do |left_index|
          right_index = matches[left_index]
          if right_index < highest
            out_of_order[left_index] = true
          else
            highest = right_index
          end
        end

        matches.keys.sort.filter_map do |left_index|
          right_index = matches[left_index]
          moved_relatively = out_of_order[left_index]
          moved_absolutely = comparable_positions && left_index != right_index
          next unless moved_relatively || moved_absolutely

          element = left_elements[left_index]
          Finding.new(:reordered, element.label, left_index + 1, right_index + 1, left_path, element.line, right_path)
        end
      end

      # Pair by id first, because an id is the document's own identity and the
      # protocol requires it unique. Everything else pairs by document order,
      # which still catches an id that differs between the two sides.
      #
      # Every element is a position, including one carrying nothing this
      # compares. Leaving those out collapsed the order, so an attribute that
      # moved from a compared element onto a plain one left two identical
      # sequences and reported nothing. They are never a finding themselves.
      #
      # The id matches that appear in the same relative order on both sides
      # also act as anchors: order pairing runs inside the segments between
      # them, so an element inserted on one side shifts its own segment and
      # not the rest of the file. An id match that crosses another still pairs
      # by id; it just does not delimit a segment.
      def correspond(left_elements, right_elements)
        matches = id_matches(left_elements, right_elements)
        anchors = ordered_anchors(matches)
        anchored = anchors.to_h
        consumed_left = matches.keys.to_h { |index| [index, true] }
        consumed_right = matches.values.to_h { |index| [index, true] }

        pairs = matches.filter_map do |left_index, right_index|
          [left_elements[left_index], right_elements[right_index]] unless anchored.key?(left_index)
        end

        left_cursor = 0
        right_cursor = 0
        (anchors + [[left_elements.length, right_elements.length]]).each do |left_stop, right_stop|
          left_run = (left_cursor...left_stop).reject { |index| consumed_left[index] }
          right_run = (right_cursor...right_stop).reject { |index| consumed_right[index] }
          pairs.concat(align(left_run, right_run, left_elements, right_elements))
          pairs << [left_elements[left_stop], right_elements[right_stop]] if left_stop < left_elements.length
          left_cursor = left_stop + 1
          right_cursor = right_stop + 1
        end
        pairs
      end

      # Inside a run, position means something only when the two sides put the
      # same number of elements there. Then every element counts as a position,
      # including one carrying nothing this compares, which is what makes an
      # attribute that moved onto a plain element visible.
      #
      # When the counts differ the two sides are shaped differently, which for
      # a pair of templates is ordinary: one audience needs a wrapper the other
      # does not. Position is then meaningless, and pairing on it would report
      # every element after the first difference. The run falls back to lining
      # up only the elements that carry something to compare, so a wrapper
      # costs nothing and movement inside that run is what goes unseen.
      def align(left_run, right_run, left_elements, right_elements)
        if left_run.length != right_run.length
          left_run = left_run.reject { |index| left_elements[index].attributes.empty? }
          right_run = right_run.reject { |index| right_elements[index].attributes.empty? }
        end

        [left_run.length, right_run.length].max.times.map do |offset|
          left_index = left_run[offset]
          right_index = right_run[offset]
          [left_index && left_elements[left_index], right_index && right_elements[right_index]]
        end
      end

      def id_matches(left_elements, right_elements)
        available = {}
        right_elements.each_with_index do |element, index|
          (available[element.id] ||= []) << index if element.id
        end

        left_elements.each_with_index.each_with_object({}) do |(element, index), matches|
          next unless element.id

          right_index = available[element.id]&.shift
          matches[index] = right_index if right_index
        end
      end

      def ordered_anchors(matches)
        last = -1
        matches.keys.sort.filter_map do |left_index|
          right_index = matches[left_index]
          next if right_index <= last

          last = right_index
          [left_index, right_index]
        end
      end

      # An element carrying nothing this compares is a position and never a
      # finding, on either side of a pair and on its own.
      def compare(left, right, left_path, right_path)
        return [] if left&.attributes.to_h.empty? && right&.attributes.to_h.empty?
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
          line = source[0, source_offset(offsets, match.begin(0))].count("\n") + 1
          elements << Element.new(line, tracked(parse_attributes(match[2])))
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

      private_class_method :lint_pair, :correspond, :reorderings, :align, :id_matches, :ordered_anchors, :compare, :aspect_for, :read, :extract, :tracked,
        :source_offset, :parse_attributes, :normalize, :replacement
    end
  end
end
