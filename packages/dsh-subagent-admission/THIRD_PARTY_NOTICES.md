# Third-Party Notices

`dsh-subagent-admission` is licensed under the MIT License in `LICENSE`.
Third-party projects retain their own copyright and licence terms.

## DeepSeek Harness

The optional reference patch and conformance fixtures target DeepSeek Harness:

- Project: `deepseek-ai/deepseek-harness`
- Source target: `47f943859bef60e4160492346772ded9b24f765a`
- Licence: MIT
- Copyright: 2026 DeepSeek
- Source: <https://github.com/deepseek-ai/deepseek-harness>

The patch contains contextual and modified portions of the targeted MIT-licensed
source. DeepSeek trademarks and project identity are not licensed or endorsed
by this repository.

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Zod

The generated native client bundle contains Zod code used for runtime snapshot
validation.

- Project: Zod
- Version used by this candidate: `4.4.3`
- Licence: MIT
- Copyright: 2025 Colin McDonnell
- Source: <https://github.com/colinhacks/zod>

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime and peer dependencies

The package also interoperates with MIT-licensed DeepSeek packages, React, and
other dependencies declared in `packages/dsh-subagent-admission/package.json`.
They are resolved from the Host or installed package graph and retain the
licence files shipped by their respective distributions. The authoritative
dependency graph for this candidate is `pnpm-lock.yaml`; this notice does not
replace any dependency's complete licence text.

Development-only comparison repositories—including `dsh-turn-budget`,
`dsh-background-agents`, AgentTeams, Delegate, and Pi—are inspected as
primary-source precedents but are not copied into or distributed by this
package.
