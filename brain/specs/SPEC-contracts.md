# SPEC-contracts — SPLIT

> **Audited against live code:** 2026-08-03.

This spec has been split (per design decision) into two cohesive sub-system specs:

- **SPEC-contracts-publication** — per-publication Safe modules (`S2SPublicationModuleV2`,
  `S2SRecordsModule`). Deployed per publication; L2 only; offer/deal/config.
- **SPEC-contracts-ens** — protocol-wide naming/resolution/site-root layer
  (`ENSSubdomainRecordsContract`, `ENSOpenSubdomainRegistry`, `ENSResolverWthCCIP`, `ccip_gateway`).
  Deployed once; L1 + L2.

The two are coupled only through the `ens_records` pointer (in the publication records module) and
the INV-12 `authorizeCaller` grant (PKP may write the root). See either spec's interface section.
