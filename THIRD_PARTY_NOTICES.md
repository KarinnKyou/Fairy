# Third-party notices

This repository does not copy any third-party source code. The dependencies below are
installed by the package manager or by the DSH host; they are not covered by the
Apache-2.0 license of Fairy-DSH's original code, and their respective license,
copyright and NOTICE requirements must continue to be honoured when distributing.

| Package | Pinned version / source | License | Copyright / source |
| --- | --- | --- | --- |
| `@playwright/mcp` | `0.0.79` · [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | Microsoft; notices shipped with the package |
| `@upstash/context7-mcp` | `4.0.2` · [upstash/context7](https://github.com/upstash/context7) | MIT | Upstash; notices shipped with the package |
| `dsh-message-edit` | `0.2.3` · [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) | MIT | Moeblack; notices shipped with the package |
| `dsh-reasoning-effort` | `0.6.2` · commit `83bc8c548749d7156a03d11d875d8117e9b5d994` · [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) | MIT | HanaAyane; notices shipped with the package |
| `hono` | `4.13.2` · [honojs/hono](https://github.com/honojs/hono) | MIT | Hono contributors; notices shipped with the package |

## DSH packages provided by the host

`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and similar packages are provided by
the DSH CLI/profile host. They are not vendored into this repository and are not
relicensed by this project. Users should follow the license and copyright files shipped
with the DSH distribution.

## Local packages inside this repository

`fairy-contracts`, `dsh-browser-dock`, `dsh-balance-meter`, `dsh-fairy-startup`,
`dsh-fairy-visual` and `dsh-fairy-voice` are original code of this repository (aside from
their own dependencies) and are governed by the root `LICENSE` and `NOTICE`.

When publishing a new version, re-check versions, origins and licenses against the final
lockfile and add any newly introduced third-party dependency to this table. A dependency
being pinned does not make it original content of this project.
