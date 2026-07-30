import assert from "node:assert/strict"

import {
  attr,
  capabilityManifestJSON,
  createCapabilityManifest,
  defineCapabilityModule,
  defineComponentDefinition,
  stringCodec,
} from "../dist/registry/index.js"

const card = defineComponentDefinition({
  attributes: {
    subtitle: attr(stringCodec).optional(),
    title: attr(stringCodec),
  },
  children: "nodes",
  tag: "NodeCard",
})
const capabilities = defineCapabilityModule({
  components: [card],
  name: "node-safe",
  version: "1.0.0",
})

assert.equal("component" in card, false)
assert.deepEqual(
  JSON.parse(capabilityManifestJSON(capabilities)),
  createCapabilityManifest(capabilities),
)
