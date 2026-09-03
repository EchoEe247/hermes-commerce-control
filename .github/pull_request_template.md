## Summary

Describe the problem and the smallest coherent change that solves it.

## Change type

- [ ] Bug fix
- [ ] Documentation / developer experience
- [ ] Adapter/source change
- [ ] CLI or MCP contract change
- [ ] State/migration change
- [ ] Network/security change
- [ ] Opportunity subsystem change
- [ ] Other

## Validation

List the exact commands/tests you ran and their results. If something could not be run, state that explicitly.

```text
# Example
npm run typecheck
npm run build
node --import tsx --test test/<relevant>.test.ts
```

## Safety and compatibility

- [ ] The change preserves the preparation-only Mode-A boundary.
- [ ] No private key, seed phrase, wallet/signing credential, token, payment authorization, or production secret is included.
- [ ] I considered CLI JSON, MCP tool/schema, persisted-state, and network compatibility where relevant.
- [ ] New/changed upstream network behavior uses the repository's hardened network/SSRF controls where applicable.

If any box above does not apply or cannot be checked, explain why:

## Documentation / changelog

- [ ] User/contributor documentation is updated if behavior or workflow changed.
- [ ] Tests cover the regression/new behavior where appropriate.
- [ ] The change is focused and does not include unrelated formatting/generated-file churn.

## Related issue

Closes #
