# frozen_string_literal: true

require "spec_helper"

RSpec.describe ExpoTurbo::Rails::Cable do
  around do |example|
    configuration = described_class.instance_variable_get(:@configuration)
    described_class.remove_instance_variable(:@configuration) if described_class.instance_variable_defined?(:@configuration)
    example.run
  ensure
    described_class.instance_variable_set(:@configuration, configuration) if configuration
  end

  it "requires all host-owned callbacks before protected subscriptions can run" do
    expect { described_class.configuration }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /configure ExpoTurbo::Rails::Cable/)

    expect {
      described_class.configure(
        credential_extractor: Object.new,
        subject_resolver: ->(_) { "subject" },
        subscription_authorizer: ->(**) { true }
      )
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /credential_extractor/)
  end

  it "stores only immutable host callback configuration" do
    configuration = described_class.configure(
      credential_extractor: ->(_) { "credential" },
      subject_resolver: ->(_) { "subject" },
      subscription_authorizer: ->(**) { true }
    )

    expect(configuration).to be_frozen
    expect(configuration.credential_extractor).to respond_to(:call)
    expect(configuration.subject_resolver).to respond_to(:call)
    expect(configuration.subscription_authorizer).to respond_to(:call)
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

  def connection_class(&block)
    Class.new(::ActionCable::Connection::Base) do
      include ExpoTurbo::Rails::Cable::Connection

      class_eval(&block) if block
    end
  end

  it "authenticates through host callbacks and exposes only the resolved subject" do
    credential = "credential-not-retained"
    subject = Object.new
    seen_connection = nil
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: lambda do |connection|
        seen_connection = connection
        credential
      end,
      subject_resolver: ->(value) { (value == credential) ? subject : nil },
      subscription_authorizer: ->(**) { true }
    )
    connection = connection_class.allocate

    connection.connect

    expect(seen_connection).to be(connection)
    expect(connection.expo_turbo_subject).to be(subject)
    expect(connection.class.identifiers).to include(:expo_turbo_subject)
    expect(connection.instance_variables).not_to include(:@credential)
  end

  it "leaves an unresolved credential anonymous so public host channels stay available" do
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { "untrusted" },
      subject_resolver: ->(_) {},
      subscription_authorizer: ->(**) { true }
    )
    connection = connection_class do
      def connect
        @host_connected = true
      end

      attr_reader :host_connected
    end.allocate

    expect { connection.connect }.not_to raise_error
    expect(connection.expo_turbo_subject).to be_nil
    expect(connection.host_connected).to be(true)
  end

  it "authenticates before an existing host connect hook" do
    subject = Object.new
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { "credential" },
      subject_resolver: ->(_) { subject },
      subscription_authorizer: ->(**) { true }
    )
    connection = connection_class do
      def connect
        @host_subject = expo_turbo_subject
      end

      attr_reader :host_subject
    end.allocate

    connection.connect

    expect(connection.host_subject).to be(subject)
  end
end
