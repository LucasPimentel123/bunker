<p align="center">
  <img src="docs/assets/bunker-banner.svg" alt="Picnic Bunker — your access, independent" width="880">
</p>

<p align="center">
  <strong>An independent way back to your Picnic account.</strong><br>
  Open source. Runs locally. Your keys stay with you.
</p>

<p align="center">
  <a href="https://github.com/usePicnic/bunker/tree/feature/independent-recovery">Explore the code</a> ·
  <a href="https://github.com/usePicnic/bunker/blob/feature/independent-recovery/docs/passkey-proof.md">Local setup</a> ·
  <a href="https://github.com/usePicnic/bunker/blob/feature/independent-recovery/docs/bunker-e2e.md">Tests</a> ·
  <a href="https://github.com/usePicnic/bunker/pull/1">Implementation review</a>
</p>

---

Bunker helps you find and regain control of your Picnic accounts through an
existing **passkey** or a **connected wallet**, without a Picnic login or backend.
Account ownership and recovery rules are verified on the blockchain.

### The path back to your account

1. **Find it.** Use a passkey or connect a wallet linked to your Picnic account.
2. **Restore control.** If the passkey is unavailable, use a configured guardian
   and follow the contract's recovery delay.
3. **Prepare your next step.** Review assets, destination and the wallet paying
   network fees. Every real transaction requires your approval.

### Development preview

The implementation is being reviewed in [PR #1](https://github.com/usePicnic/bunker/pull/1).
The guided flow supports passkey discovery and guardian recovery; its withdrawal
screen is still demonstrative. A separate workbench implements asset exits with
[documented coverage limits](https://github.com/usePicnic/bunker/blob/feature/independent-recovery/docs/coverage.md).
A wallet-SDK dependency audit finding remains open before merging or releasing.

To inspect the current implementation:

```sh
git clone --branch feature/independent-recovery https://github.com/usePicnic/bunker.git
cd bunker
```

Then follow the [setup and development guide](https://github.com/usePicnic/bunker/blob/feature/independent-recovery/README.md).
Do not enter a seed, private key, password or OTP into Bunker. An existing owner,
passkey or configured recovery authority is required; an address alone is not access.

### Built in the open

- [Architecture](https://github.com/usePicnic/bunker/blob/feature/independent-recovery/docs/architecture.md)
- [Test coverage and limitations](https://github.com/usePicnic/bunker/blob/feature/independent-recovery/docs/bunker-e2e.md)
- [Contributing](https://github.com/usePicnic/bunker/blob/feature/independent-recovery/CONTRIBUTING.md)
- [MIT license](LICENSE)

Made by [Picnic](https://usepicnic.com).
