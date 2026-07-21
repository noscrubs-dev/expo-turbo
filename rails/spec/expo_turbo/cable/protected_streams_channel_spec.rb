# frozen_string_literal: true

require "spec_helper"
require "action_cable/test_helper"
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
  let(:stream_name) { "room:expo" }
  let(:grant) { "opaque-grant" }
  let(:signed_stream_name) { ::Turbo::StreamsChannel.signed_stream_name([stream_name]) }

  def subscribe(subject:, signed_stream_name:, grant:)
    connection = ::ActionCable::Channel::ConnectionStub.new(expo_turbo_subject: subject)
    channel = described_class.new(
      connection,
      "protected-stream",
      {signed_stream_name:, grant:}.with_indifferent_access
    )
    channel.singleton_class.include(::ActionCable::Channel::ChannelStub)
    channel.subscribe_to_channel
    channel
  end

  it "authorizes the verified stream name with the host subject and opaque grant" do
    calls = []
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "not used by a channel" },
      subject_resolver: ->(_) { raise "not used by a channel" },
      subscription_authorizer: lambda do |**arguments|
        calls << arguments
        true
      end
    )

    channel = subscribe(subject:, signed_stream_name:, grant:)

    expect(channel).not_to be_rejected
    expect(channel.streams).to eq([stream_name])
    expect(calls).to eq([{subject:, stream_name:, grant:}])
  end

  it "rejects an invalid signed stream without asking the host authorizer" do
    authorizer_calls = 0
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "not used by a channel" },
      subject_resolver: ->(_) { raise "not used by a channel" },
      subscription_authorizer: lambda do |**|
        authorizer_calls += 1
        true
      end
    )

    channel = subscribe(subject:, signed_stream_name: "forged", grant:)

    expect(channel).to be_rejected
    expect(channel.streams).to be_empty
    expect(authorizer_calls).to eq(0)
  end

  it "rejects missing or malformed grants without asking the host authorizer" do
    authorizer_calls = 0
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "not used by a channel" },
      subject_resolver: ->(_) { raise "not used by a channel" },
      subscription_authorizer: lambda do |**|
        authorizer_calls += 1
        true
      end
    )

    [nil, "", "\xFF".dup.force_encoding(Encoding::UTF_8), {grant: "not-opaque"}].each do |invalid_grant|
      channel = subscribe(subject:, signed_stream_name:, grant: invalid_grant)

      expect(channel).to be_rejected
      expect(channel.streams).to be_empty
    end
    expect(authorizer_calls).to eq(0)
  end

  it "rejects an absent subject or an authorization denial" do
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { raise "not used by a channel" },
      subject_resolver: ->(_) { raise "not used by a channel" },
      subscription_authorizer: ->(**) { false }
    )

    absent_subject = subscribe(subject: nil, signed_stream_name:, grant:)
    denied = subscribe(subject:, signed_stream_name:, grant:)

    expect(absent_subject).to be_rejected
    expect(denied).to be_rejected
    expect(absent_subject.streams).to be_empty
    expect(denied.streams).to be_empty
  end
end
