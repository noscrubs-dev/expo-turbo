# frozen_string_literal: true

require "spec_helper"
require "action_cable/subscription_adapter/test"
require "active_job/queue_adapters/test_adapter"
require "logger"

RSpec.describe ExpoTurbo::Rails::Cable do
  let(:content) { '<turbo-stream action="remove" target="notice"></turbo-stream>' }

  around do |example|
    server = ActionCable.server
    previous_adapter = server.instance_variable_get(:@pubsub)
    previous_logger = server.config.logger
    previous_queue_adapter = described_class::ProtectedBroadcastJob.queue_adapter
    @test_adapter = ActionCable::SubscriptionAdapter::Test.new(server)
    @job_adapter = ActiveJob::QueueAdapters::TestAdapter.new
    server.config.logger = Logger.new(IO::NULL)
    server.instance_variable_set(:@pubsub, @test_adapter)
    described_class::ProtectedBroadcastJob.queue_adapter = @job_adapter
    example.run
  ensure
    server.instance_variable_set(:@pubsub, previous_adapter)
    server.config.logger = previous_logger
    described_class::ProtectedBroadcastJob.queue_adapter = previous_queue_adapter
  end

  it "keeps protected and public broadcasts on distinct Action Cable topics" do
    token = described_class.protected_stream_token_for("room")

    described_class.broadcast_protected_to("room", content:)
    ExpoTurbo::Rails::Streams.broadcast_to("room", content:)

    expect(broadcast_payloads(token)).to eq([content])
    expect(broadcast_payloads("room:expo")).to eq([content])
  end

  it "queues a validated isolated token without exposing job arguments" do
    token = described_class.protected_stream_token_for("room")

    described_class.broadcast_protected_later_to("room", content:)

    job = @job_adapter.enqueued_jobs.fetch(0)
    arguments = ActiveJob::Arguments.deserialize(job[:args])
    expect(job[:job]).to eq(described_class::ProtectedBroadcastJob)
    expect(arguments).to eq([token, {content:}])
    expect(described_class::ProtectedBroadcastJob.log_arguments?).to be(false)
    expect(broadcast_payloads(token)).to be_empty

    ActiveJob::Base.execute(job)

    expect(broadcast_payloads(token)).to eq([content])
  end

  it "does not publish a forged protected token" do
    expect {
      described_class::ProtectedBroadcastJob.new.perform("forged", content:)
    }.to raise_error(ArgumentError, /valid Expo Turbo protected stream token/)
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  def broadcast_payloads(stream)
    @test_adapter.broadcasts(stream).map { |message| ActiveSupport::JSON.decode(message) }
  end
end
