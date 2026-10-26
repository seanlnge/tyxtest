---
surface: Setup command
description: Initialize tyxtest in a target repository by writing its configuration and adding the required ignore and merge settings.
entry: src/commands/setup.ts
---

- [writes-config] Setup writes tyxtest/tyxtest.config.json.
- [configures-git] Setup adds .env, .tyxtest/, and tyxtest/.pending.json to .gitignore and configures index-file merging.
