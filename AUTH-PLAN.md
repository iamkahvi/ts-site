# Superseded authentication plan

This document is retained only to record that the earlier authentication
proposal was superseded by [CLIENT-LOGIN-PLAN.md](./CLIENT-LOGIN-PLAN.md).

The active design is:

- client devices are tagged `tag:ts-site-client` by a tailnet administrator;
- the CLI saves only the normalized host URL;
- the host resolves the direct peer address with `tailscale whois --json`;
- every `/api/*` request requires the exact client tag;
- localhost and LAN callers are not exempt;
- authorization is not cached between requests;
- host-side Tailscale control-plane credentials remain separate from client
  authorization.
