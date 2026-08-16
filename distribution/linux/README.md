# Caffold for Linux

This archive contains the Caffold server and CLI for a 64-bit glibc Linux
host. Install a Vulkan loader before running it. A physical Vulkan GPU is
optional: `caffold serve --whisper-acceleration auto` falls back to CPU, and
`--whisper-acceleration cpu` skips GPU initialization.

Run `caffold --help` for the complete CLI. Caffold listens on localhost by
default. Optional tailnet-only remote access requires an independently
installed and connected Tailscale CLI:

```sh
caffold tailscale enable
```

Caffold does not install, embed, or publicly expose Tailscale Funnel.
