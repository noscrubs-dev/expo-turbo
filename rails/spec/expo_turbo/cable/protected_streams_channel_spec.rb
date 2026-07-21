# frozen_string_literal: true

require "spec_helper"
require "action_cable/channel/test_case"

RSpec.describe ExpoTurbo::Rails::Cable::ProtectedStreamsChannel do
  around do |example|
    configuration = ExpoTurbo::Rails::Cable.instance_variable_get(:@configuration)
    ExpoTurbo::Rails::Cable.remove_instance_variable(:@configuration) if ExpoTurbo::Rails::Cable.instance_variable_defined?(:@configuration)
    example.run
  ensure
    ExpoTurbo::Rails::Cable.instance_variable_set(:@configuration, configuration) if configuration
  end

  let(:subject) { Object.new }
  let(:grant) { "opaque-grant" }
  let(:token) { ExpoTurbo::Rails::Cable.protected_stream_token_for("room") }

  def configure_cable(subject: self.subject, authorizer: ->(**) { true }, reporter: ->(**) {})
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { "credential" },
      subject_resolver: ->(_) { subject },
      subscription_authorizer: authorizer,
      subscription_error_reporter: reporter
    )
  end

  def subscribe(channel_class = described_class, connection: nil, token: self.token, grant: self.grant)
    connection ||= ::ActionCable::Channel::ConnectionStub.new(expo_turbo_subject: subject)
    channel = channel_class.new(connection, "protected-stream", {signed_stream_name: token, grant:}.with_indifferent_access)
    channel.singleton_class.include(::ActionCable::Channel::ChannelStub)
    channel.subscribe_to_channel
    channel
  end

  it "authorizes the decoded Expo stream but subscribes only to its isolated token" do
    calls = []
    configure_cable(authorizer: lambda do |**arguments|
      calls << arguments
      true
    end)

    channel = subscribe
    generic_turbo_channel = subscribe(::Turbo::StreamsChannel)

    expect(channel).not_to be_rejected
    expect(channel.streams).to eq([token])
    expect(calls).to eq([{subject:, stream_name: "room:expo", grant:}])
    expect(generic_turbo_channel).to be_rejected
    expect(generic_turbo_channel.streams).to be_empty
  end

  it "rejects malformed tokens without invoking host callbacks" do
    authorizer_calls = 0
    configure_cable(authorizer: lambda do |**|
      authorizer_calls += 1
      true
    end)

    [nil, {}, [], 1, "\xFF".dup.force_encoding(Encoding::UTF_8), "forged"].each do |invalid_token|
      expect { subscribe(token: invalid_token) }.not_to raise_error
      expect(subscribe(token: invalid_token)).to be_rejected
    end

    expect(authorizer_calls).to eq(0)
  end

  it "does not resolve a subject until a descriptor token has passed verification" do
    extraction_count = 0
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: lambda do |_|
        extraction_count += 1
        "credential"
      end,
      subject_resolver: ->(_) { subject },
      subscription_authorizer: ->(**) { true },
      subscription_error_reporter: ->(**) {}
    )
    connection = Class.new(::ActionCable::Channel::ConnectionStub) do
      include ExpoTurbo::Rails::Cable::Connection
    end.new

    expect(subscribe(connection:, token: "forged")).to be_rejected
    expect(extraction_count).to eq(0)
  end

  it "rejects absent subjects and explicit authorization denials" do
    configure_cable(subject: nil)
    absent_subject = subscribe(connection: ::ActionCable::Channel::ConnectionStub.new(expo_turbo_subject: nil))
    expect(absent_subject).to be_rejected

    configure_cable(authorizer: ->(**) { false })
    expect(subscribe).to be_rejected
  end

  it "rejects callback failures through a redacted observer" do
    events = []
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "credential=secret" },
      subject_resolver: ->(_) { raise "not reached" },
      subscription_authorizer: ->(**) { raise "not reached" },
      subscription_error_reporter: ->(**event) { events << event }
    )
    connection = Class.new(::ActionCable::Channel::ConnectionStub) do
      include ExpoTurbo::Rails::Cable::Connection
    end.new

    channel = nil
    expect { channel = subscribe(connection:) }.not_to raise_error
    expect(channel).to be_rejected
    expect(events).to eq([{code: :subject_resolution_failed, error_class: "RuntimeError"}])
    expect(events.to_s).not_to include("credential=secret")
  end

  it "rejects authorizer failures without exposing the grant to the observer" do
    events = []
    configure_cable(
      authorizer: ->(**) { raise "grant=#{grant}" },
      reporter: ->(**event) { events << event }
    )

    channel = subscribe

    expect(channel).to be_rejected
    expect(events).to eq([{code: :subscription_authorization_failed, error_class: "RuntimeError"}])
    expect(events.to_s).not_to include(grant)
  end

  it "keeps a callback failure rejected when the error reporter itself fails" do
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "credential=secret" },
      subject_resolver: ->(_) { raise "not reached" },
      subscription_authorizer: ->(**) { raise "not reached" },
      subscription_error_reporter: ->(**) { raise "observer unavailable" }
    )
    connection = Class.new(::ActionCable::Channel::ConnectionStub) do
      include ExpoTurbo::Rails::Cable::Connection
    end.new

    channel = nil
    expect { channel = subscribe(connection:) }.not_to raise_error
    expect(channel).to be_rejected
  end
end
