# Linux Release Process

This document owns Linux artifact, Formula, and native verification details.
The [shared release process](release.md) owns versioning and publication order.

## Supported targets

Caffold publishes glibc Linux binaries for:

- `x86_64`, built on `ubuntu-24.04`;
- `aarch64`, built on `ubuntu-24.04-arm`.

These native runners compile the bundled Whisper backend with Vulkan enabled.
The build requires CMake, `glslc`, Vulkan headers and loader development files,
`file`, and `binutils`. CUDA, musl, ARM32, and cross-compiled release artifacts
are outside this contract.

## Native package command

On a supported Linux host:

```sh
distribution/linux/package metadata
distribution/linux/package archive
```

The archive command:

1. validates Cargo and package versions;
2. builds with `cargo build --release --locked`;
3. records the default Homebrew Vulkan loader runpath;
4. checks ELF architecture, `caffold --version`, dynamic dependency resolution,
   and the `libvulkan.so.1` dependency;
5. packages the binary, license, and Linux README;
6. extracts and verifies the archive; and
7. writes its SHA-256 file.

Generated output is under `target/caffold-linux` and is not source state.

## Formula

`distribution/linux/render-formula` consumes one version and the two verified
archive digests. The generated `Formula/caffold.rb` selects the native URL with
`on_intel` or `on_arm`, depends on Linux and `vulkan-loader`, installs the
prebuilt executable, and defines the localhost user service.

After the GitHub Release exists, native Formula jobs render the unpublished
Formula into a read-only checkout of `panarch/homebrew-tap`, run Homebrew style
and strict audit, install it, verify `caffold --version`, start a CPU-only
server, check `/api/health`, and uninstall it. Both architectures must pass
before the final tap job can commit and push the Cask and Formula together.

## Pull-request and inference evidence

Ordinary pull requests build and verify both native release archives. The x86
browser and Rust jobs also compile the Vulkan-enabled Linux dependency graph.

Actual speech inference is intentionally separate from required PR checks. The
manual `Whisper Smoke` workflow downloads a checksum-pinned 75 MiB multilingual
tiny model and a checksum-pinned WAV fixture, then runs the ignored Rust live
test in CPU-only mode. The production first-use model remains
`large-v3-turbo`; the smoke model is test evidence, not a product-model change.
