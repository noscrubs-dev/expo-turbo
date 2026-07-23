# Expo Turbo 0.1.0 candidate

This is a non-publishing candidate record. It does not announce a stable
release, reserve a registry version, or close the remaining compatibility
gates.

| Field | Value |
| --- | --- |
| Public commit | `0163220dc8c3b7cb99c3f02c3f3b325e526d2740` |
| Release workflow | [run 30021116358](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30021116358) |
| npm artifact | `expo-turbo-0.1.0.tgz` |
| npm SHA-256 | `1ef8ef9f877248716f69bdf3525f611375aad6057a037da2f756c188ec2d71d2` |
| Ruby artifact | `expo_turbo-rails-0.1.0.gem` |
| Ruby SHA-256 | `45599d376f966133b94aa84dca16f4a802361e83926e4429d6f77ab5397bb073` |

The workflow built both artifacts from the exact public commit, installed each
in a clean consumer, ran the root package, gem matrix, Expo example, and Rails
example gates, bound its OIDC identity to `main` and the protected `release`
environment, and emitted an offline GitHub provenance bundle.

After downloading the `release-candidate` artifact, both files matched
`SHA256SUMS`, and `gh attestation verify --bundle provenance.jsonl --repo
noscrubs-dev/expo-turbo` admitted each artifact.

Stable npm/RubyGems publication remains prohibited until the compatibility
manifest's production-host and physical-device evidence is complete. Merging
this evidence record advances `main`, so run `30021116358` is deliberately a
superseded pipeline proof rather than the publishable candidate. The final
gated commit must produce a new candidate, and stable publication must reuse
that later run's exact frozen bytes.
