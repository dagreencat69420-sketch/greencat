# Program fixtures for the localnet suites

These are public, already-deployed third-party programs. They are committed so CI and the
localnet tests don't depend on a public RPC being up. `apps/api/test/localnet.ts` loads them
into `solana-test-validator` with `--bpf-program`.

| File | Program id | sha256 |
|---|---|---|
| `orao_vrf.so` | ORAO VRF v2 `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y` | `f7603b1a993e7853a209a4d04e93e7b05cb41264580bb62030be0bd36889fafe` |
| `mpl_token_metadata.so` | Metaplex Token Metadata `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |

To refresh them (this re-pins whatever is currently deployed; re-run all suites afterwards):

```bash
solana program dump -u mainnet-beta VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y tests/fixtures/orao_vrf.so
solana program dump -u mainnet-beta metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s tests/fixtures/mpl_token_metadata.so
sha256sum tests/fixtures/*.so
```
