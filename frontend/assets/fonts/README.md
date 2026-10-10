# Bundled fonts

Every bundled font is distributed under the SIL Open Font License 1.1. Each font
keeps its release's unmodified license text beside it as `<Name>-OFL.txt`.

Interface and code fonts are copied unmodified from the upstream project's own
release. The [Nerd Fonts](#nerd-fonts) builds of the code fonts are converted
from TTF or OTF to WOFF2 without changing the font data.

Interface fonts ship as one variable file covering the whole weight axis. Code
fonts ship as static Regular and Bold.

## Geist Sans

[`vercel/geist-font`](https://github.com/vercel/geist-font) release `v1.7.2`,
`geist-font-v1.7.2.zip`, file `Geist/webfonts/Geist[wght].woff2`. Weight axis
`100-900`. `GeistSans-OFL.txt` is the release's `OFL.txt`, the same text Geist
Mono carries.

- `GeistSans-Variable.woff2`: `a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8`

## Inter

[`rsms/inter`](https://github.com/rsms/inter) release `v4.1`, `Inter-4.1.zip`,
file `web/InterVariable.woff2`. Weight axis `100-900`, optical size axis
`14-32`.

- `Inter-Variable.woff2`: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`

## Pretendard

[`orioncactus/pretendard`](https://github.com/orioncactus/pretendard) release
`v1.3.9`, `Pretendard-1.3.9.zip`, file
`web/variable/woff2/PretendardVariable.woff2`. Weight axis `45-930`. Covers all
11,172 modern Hangul syllables.

- `Pretendard-Variable.woff2`: `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`

## D2 Coding

NAVER's [`d2-coding-font`](https://github.com/naver/d2-coding-font) repository at
commit `9d6f0559691ebe670a23fbf7b72a8dc42362f1fb`.

- `D2Coding-Regular.woff2`: `49a1a380c1079bc74950acf6152cbfc4fd69101813e18127e1be45bd8bb15063`
- `D2Coding-Bold.woff2`: `7e03de7314d7a2d5a8a275531c760902c71494ac1c7d1fde0dab4f2f318f0ca0`

## 0xProto

[`0xType/0xProto`](https://github.com/0xType/0xProto) release `2.502`,
`0xProto_2_502.zip`.

- `0xProto-Regular.woff2`: `8fcccc7334a3e4c11d974c162c33a4ca8a1ea7cbca35d1ae0507f30832388ada`
- `0xProto-Bold.woff2`: `00c156d463f505c724e5c355d591f45d9ed48ce0e8af944d7ad4539a92eee438`

## Geist Mono

[`vercel/geist-font`](https://github.com/vercel/geist-font) release `v1.7.2`,
`geist-font-v1.7.2.zip`.

- `GeistMono-Regular.woff2`: `e4507fb4fb5f832fbbb6c06aea4206274ba3083007f23fa8cbc0e87a10acf95b`
- `GeistMono-Bold.woff2`: `c1287452c531c82457793da41dd5512af95d01fbc851c8b928203f9ca4967279`

## IBM Plex Mono

[`IBM/plex`](https://github.com/IBM/plex) release `@ibm/plex-mono@2.5.0`,
`ibm-plex-mono.zip`.

- `IBMPlexMono-Regular.woff2`: `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350`
- `IBMPlexMono-Bold.woff2`: `ea576f38d05cc44cca48c45314984beb8cc1d2b886f58e1dce99f15dc344eb1d`

## JetBrains Mono

[`JetBrains/JetBrainsMono`](https://github.com/JetBrains/JetBrainsMono) release
`v2.304`, `JetBrainsMono-2.304.zip`.

- `JetBrainsMono-Regular.woff2`: `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2`
- `JetBrainsMono-Bold.woff2`: `c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2`

## Monaspace Neon

[`githubnext/monaspace`](https://github.com/githubnext/monaspace) release
`v1.400`, `monaspace-webfont-static-v1.400.zip`. The release package carries no
license file; `MonaspaceNeon-OFL.txt` comes from the repository at the same tag.

- `MonaspaceNeon-Regular.woff2`: `6b6980f24d115e98e96b1a5d06a5a7fe6454de9b216d479a7e6923c0456a5f41`
- `MonaspaceNeon-Bold.woff2`: `37f1c50c462e51d871d52c36b190628e94c379c7157e07e04e1e2f943f07f54f`

## Nerd Fonts

[`ryanoasis/nerd-fonts`](https://github.com/ryanoasis/nerd-fonts) release
`v3.5.1`. Each face is the release's `Nerd Font Mono` build of one bundled code
font: the font with icon sets and Powerline symbols added, each fitted to one
cell. Three builds carry another name because the original's license reserves
it: D2 Coding, IBM Plex Mono, and Monaspace become D2KodingLigature, BlexMono,
and Monaspice.

The release ships TTF and OTF only. Each file is converted with fontTools
`4.66.1` (Brotli `1.2.0`), which keeps every table and glyph outline:

```sh
uvx --from 'fonttools[woff]==4.66.1' fonttools ttLib.woff2 compress -o <name>.woff2 <name>.ttf
```

Each `<Name>NerdFont-OFL.txt` is the license file of its release archive. The
added icon sets come from these projects, as listed in every archive's README:

| Icon set name          | upstream                                              | version         | license     |
|------------------------|-------------------------------------------------------|-----------------|-------------|
| Codicons               | https://github.com/microsoft/vscode-codicons          | 0.0.45          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | 2.17.0          | MIT         |
| extraglyphs            | https://github.com/source-foundry/Hack                | -               | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | 6.5.1           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | 0.0.3           | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | 1.3.0           | unlicensed  |
| MaterialDesign         | https://github.com/Templarian/MaterialDesign-Font     | Oct 6, 2022     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | 18.3.0          | MIT         |
| Seti and original      | https://github.com/jesseweed/seti-ui                  | 0.8.1           | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | 1.001           | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | 1.200           | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | 1.000 (ca 2013) | MIT         |
| Power Symbols IEC      | https://github.com/jloughry/Unicode                   | Feb 2015        | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | 2.0.10 (1.100)  | OFL 1.1     |

### D2KodingLigature Nerd Font

`D2Coding.tar.xz`, D2 Coding `1.3.2` with ligatures.
`D2KodingLigatureNerdFont-OFL.txt` is the archive's `OFL.txt`.

- `D2Coding.tar.xz`: `acdc66f5df6e64a7e1d41f89930b163da5345cf45f7dd08e41a98da255002c95`
- `D2KodingLigatureNerdFontMono-Regular.ttf`: `7cb0d9ff115ce2de495cfc42768781268652d99548be26f43a9c14f9e566c485`
- `D2KodingLigatureNerdFontMono-Bold.ttf`: `a6635d892bed813bda81427c1859dd766c502894baf82113dae6454deb8735d5`
- `D2KodingLigatureNerdFontMono-Regular.woff2`: `753c9fa25e5fd246ac893c3e772f32349aacd0f67d8c4a6104db20b4403e8c83`
- `D2KodingLigatureNerdFontMono-Bold.woff2`: `45a61da3c213b0c9b7314ce1f7e1ad7b065d00e287e28ca50f2526cd5b59410a`

### 0xProto Nerd Font

`0xProto.tar.xz`, 0xProto `2.502`. `0xProtoNerdFont-OFL.txt` is the archive's
`LICENSE`.

- `0xProto.tar.xz`: `3f2d36e4fa8b3af2f97b14b57c5b0f57f4c1bda5a59533fb913a9ff3344db7ce`
- `0xProtoNerdFontMono-Regular.ttf`: `9d8f521c75a8aa804a942baa3f6438cbfd311d12d59251af955aa75f51b8e135`
- `0xProtoNerdFontMono-Bold.ttf`: `77d1c2a6fd7d50686b9896fa476cb759bd9e5644998a959161e18068ae15b642`
- `0xProtoNerdFontMono-Regular.woff2`: `c7d5993a91fb659ab4bdb482e1ed9ab843001ebad3f82d9cb820dd5601efe476`
- `0xProtoNerdFontMono-Bold.woff2`: `e235bb9aefb6dfd693c6cc9c828defc5619e1cd4c8fabf4411ecb4678e961b53`

### GeistMono Nerd Font

`GeistMono.tar.xz`, Geist Mono `1.700`. `GeistMonoNerdFont-OFL.txt` is the
archive's `LICENSE`.

- `GeistMono.tar.xz`: `d3ba4a7418cde16963fda0caa4f7ae866c509e0a864ec21e393455e1906e070c`
- `GeistMonoNerdFontMono-Regular.otf`: `ac1fd18ba4cf7c2d0e58af2765f7c913f88c0f43b49f7b6609f9572755112756`
- `GeistMonoNerdFontMono-Bold.otf`: `f1f3dc81e89f6c8cf4b5b0153eb380e80d5e21a880437025364e3dfba2ae946d`
- `GeistMonoNerdFontMono-Regular.woff2`: `785d45d48a45dbe4706a74b08a8b7fd9021906d5b7adc21d09074e9ae9658eee`
- `GeistMonoNerdFontMono-Bold.woff2`: `76bb1db93c90f0b5ad7e0c0f4a0a2199eb402367db7d19b2c142bf7910c56f02`

### BlexMono Nerd Font

`IBMPlexMono.tar.xz`, IBM Plex Mono `2.004`. `BlexMonoNerdFont-OFL.txt` is the
archive's `LICENSE.txt`.

- `IBMPlexMono.tar.xz`: `3d226683be9fc35f98683837568497f300307bc9b7aefc1617a368f190ef963a`
- `BlexMonoNerdFontMono-Regular.ttf`: `9f8fe62fc71c7463677fb8dc6e47fe77aa470649383be0731706f746468b61eb`
- `BlexMonoNerdFontMono-Bold.ttf`: `0f0b5fc5970a8272bfa3a97e4aae465dd91b4da0faa76662635bc7bd1b91731d`
- `BlexMonoNerdFontMono-Regular.woff2`: `ec18b00ba10137c18cce3c029565234cdc20cdba136c18122dee5244ad7adeab`
- `BlexMonoNerdFontMono-Bold.woff2`: `8aebdda4acdef08562ffe23ae1851528740b8462711e3bf7b4b72f98b4386622`

### JetBrainsMono Nerd Font

`JetBrainsMono.tar.xz`, JetBrains Mono `2.304` with ligatures (not the `NL`
files). `JetBrainsMonoNerdFont-OFL.txt` is the archive's `OFL.txt`.

- `JetBrainsMono.tar.xz`: `04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf`
- `JetBrainsMonoNerdFontMono-Regular.ttf`: `f2a5ea6cfab397445ffab00c0370927b66d61e560a05db5db271b42006381c1a`
- `JetBrainsMonoNerdFontMono-Bold.ttf`: `bfcf9a917276ffc058867d87cbc8a5b2f1ab0f4b710e9170dc02763ccb80bd4b`
- `JetBrainsMonoNerdFontMono-Regular.woff2`: `2b777374f6ba42c46919fb5f8bb1f607ccff116bf54d44c7a453ebeb70b794a8`
- `JetBrainsMonoNerdFontMono-Bold.woff2`: `8369916519fcedd4c60e19dcc5b9bb58301e186dda83c56768d8937951da353d`

### MonaspiceNe Nerd Font

`Monaspace.tar.xz`, Monaspace Neon `1.400`. `MonaspiceNeNerdFont-OFL.txt` is the
archive's `LICENSE`.

- `Monaspace.tar.xz`: `7cdb44b7cd3855a231641b3cc4cf38f434d615d12e1c475eb86232868c667dc0`
- `MonaspiceNeNerdFontMono-Regular.otf`: `052c899680aec112098999cba87958d5e15d643c79eae79fa853b0af43b8d2d7`
- `MonaspiceNeNerdFontMono-Bold.otf`: `5ae3341267b78f722e1337fd14cd6a095bfbcd5d7bc0cb11d99ec06e3f563b90`
- `MonaspiceNeNerdFontMono-Regular.woff2`: `7996204d3e4bbab256e1902d0154bcb3783adc83e41b3004747622cbbd976ff7`
- `MonaspiceNeNerdFontMono-Bold.woff2`: `270f7b0a252acef24b15157204e95f43c2906c6dc71c4bd5a626cfe97709a027`
