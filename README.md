# iFacto Claude Playbook

The iFacto Claude Code plugin marketplace: the iFacto agents, slash commands and skills for
Microsoft Dynamics 365 Business Central (AL) development.

**Generated — do not edit, pull requests are not accepted.** This repository is a published copy
of iFacto's internal playbook repository and is overwritten on every release.
Source commit: `450f9f6b309b316c21affddc2f4646bd20f9eebb`.

## Install

```bash
claude plugin marketplace add waldo1001/waldo.BCObservatory
claude plugin marketplace add https://github.com/iFacto-Business-Solutions-NV/ifacto-claude-playbook.git
claude plugin install ifacto@ifacto-playbook
```

The first line registers the marketplace of the `bc-observatory` plugin, a dependency of `ifacto`:
without it `ifacto` does not load. Node.js 22.23.4+ (or 24.22.1+) is needed for the `npx` MCP servers.

iFacto machines receive it automatically through Claude for Teams managed settings.
