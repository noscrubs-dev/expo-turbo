# Maestro iOS evidence

These flows drive the standalone Expo example through Expo Go. Start Metro from
`example/expo` on the port named by the flow, then select a dedicated simulator:

```sh
bun run start -- --lan --port 8082
maestro --device <simulator-uuid> test \
  -e EXPO_URL=exp://<metro-lan-address>:8082/--/demo \
  .maestro/gallery-smoke.yaml
```

With the standalone Rails host running on the origin compiled into Metro, the
controlled ordinary Frame-morph proof is:

```sh
maestro --device <simulator-uuid> test \
  -e EXPO_URL=exp://<metro-lan-address>:8082/--/demo \
  .maestro/live-frame-morph.yaml
```

The flows are interaction evidence, not part of package or Expo bundle CI. Keep
them deterministic, text-addressable, and isolated from a developer's simulator.
