# Vendor

This directory contains upstream or user-owned source repositories as Git submodules.

For vendored skills, prefer updating the source repository first and then syncing the copied skill into `skills/`. Record source names, URLs, and submodule paths in `meta.ts`.

Initialize submodules with:

```bash
git submodule update --init --recursive
```
