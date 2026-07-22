# frozen_string_literal: true

require "spec_helper"
require "action_cable/channel/test_case"

RSpec.describe ExpoTurbo::Rails::Cable do
  around do |example|
    configuration = described_class.instance_variable_get(:@configuration)
    described_class.remove_instance_variable(:@configuration) if described_class.instance_variable_defined?(:@configuration)
    example.run
  ensure
    described_class.instance_variable_set(:@configuration, configuration) if configuration
  end

  it "requires immutable host callbacks before protected sources can run" do
    expect { described_class.configuration }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /configure ExpoTurbo::Rails::Cable/)

    expect {
      described_class.configure(
        credential_extractor: Object.new,
        subject_resolver: ->(_) { "subject" },
        subscription_authorizer: ->(**) { true },
        subscription_error_reporter: ->(**) {}
      )
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /credential_extractor/)

    configuration = described_class.configure(
      credential_extractor: ->(_) { "credential" },
      subject_resolver: ->(_) { "subject" },
      subscription_authorizer: ->(**) { true },
      subscription_error_reporter: ->(**) {}
    )

    expect(configuration).to be_frozen
    expect(configuration.credential_extractor).to respond_to(:call)
    expect(configuration.subject_resolver).to respond_to(:call)
    expect(configuration.subscription_authorizer).to respond_to(:call)
    expect(configuration.subscription_error_reporter).to respond_to(:call)
  end

  it "uses a deterministic verifier isolated from Turbo's public stream verifier" do
    token = described_class.protected_stream_token_for("room")

    expect(token.encoding).to eq(Encoding::UTF_8)
    expect(described_class.protected_stream_token_for("room")).to eq(token)
    expect(described_class.verified_protected_stream_name(token)).to eq("room:expo")
    expect(::Turbo::StreamsChannel.verified_stream_name(token)).to be_nil
  end
end

RSpec.describe ExpoTurbo::Rails::Cable::Connection do
  around do |example|
    configuration = ExpoTurbo::Rails::Cable.instance_variable_get(:@configuration)
    ExpoTurbo::Rails::Cable.remove_instance_variable(:@configuration) if ExpoTurbo::Rails::Cable.instance_variable_defined?(:@configuration)
    example.run
  ensure
    ExpoTurbo::Rails::Cable.instance_variable_set(:@configuration, configuration) if configuration
  end

  def connection_class
    Class.new(::ActionCable::Channel::ConnectionStub) do
      include ExpoTurbo::Rails::Cable::Connection
    end
  end

  it "exposes the Cable request through a public host callback bridge" do
    request = Object.new
    connection = Class.new do
      include ExpoTurbo::Rails::Cable::Connection

      define_method(:request) { request }
      private :request
    end.new

    expect(connection.expo_turbo_request).to be(request)
  end

  it "resolves and caches a subject only when a protected channel asks for it" do
    extraction_count = 0
    resolution_count = 0
    subject = Object.new
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: lambda do |_|
        extraction_count += 1
        "credential"
      end,
      subject_resolver: lambda do |_|
        resolution_count += 1
        subject
      end,
      subscription_authorizer: ->(**) { true },
      subscription_error_reporter: ->(**) {}
    )
    connection = connection_class.new

    expect(connection.identifiers).to be_empty
    expect(extraction_count).to eq(0)
    expect(resolution_count).to eq(0)
    expect(connection.expo_turbo_subject).to be(subject)
    expect(connection.expo_turbo_subject).to be(subject)
    expect(extraction_count).to eq(1)
    expect(resolution_count).to eq(1)
  end

  it "caches an unresolved subject without retaining the credential" do
    extraction_count = 0
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: lambda do |_|
        extraction_count += 1
        "untrusted"
      end,
      subject_resolver: ->(_) {},
      subscription_authorizer: ->(**) { true },
      subscription_error_reporter: ->(**) {}
    )
    connection = connection_class.new

    expect(connection.expo_turbo_subject).to be_nil
    expect(connection.expo_turbo_subject).to be_nil
    expect(extraction_count).to eq(1)
    expect(connection.instance_variables).not_to include(:@credential)
  end
end
