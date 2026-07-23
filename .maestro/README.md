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

For an installed iOS `Release` build compiled with
`EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN`, the live nested Frame and Rails Frame-form
proofs run without Expo Go or Metro:

```sh
maestro --device <simulator-uuid> test \
  .maestro/release-ios-live-frame-morph.yaml
maestro --device <simulator-uuid> test \
  .maestro/release-ios-live-frame-form.yaml
```

The form flow submits the real Rails `422`, verifies a subsequent `204` leaves
that mounted Frame and error intact, then follows the valid canonical `303` and
verifies the error is gone.
