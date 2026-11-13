# Robinson annulation acceptance case

This case exercises a Michael addition followed by amine-mediated intramolecular ring formation and dehydration. It is independent of the caffeine layout smoke test. No exact number of elementary steps, proton transfers or rows is prescribed.

The primary experimental basis is [Ramachandran and Newman, Organic Syntheses 1961, 41, 38](https://www.orgsyn.org/demo.aspx?prep=CV5P0486), DOI [10.15227/orgsyn.041.0038](https://doi.org/10.15227/orgsyn.041.0038). It supports the specified dione/MVK inputs, KOH/methanol stage, isolable Michael trione, then pyrrolidine/benzene and removal of water with aqueous/acid workup. [Buchschacher, Fürst and Gutzwiller, Organic Syntheses 1985, 63, 37](https://www.orgsyn.org/demo.aspx?prep=CV7P0368) independently confirms the named trione and Wieland–Miescher connectivity; its asymmetric proline conditions are not substituted for the selected conditions.

The natural task is in [robinson_annulation_prompt.txt](fixtures/robinson_annulation_prompt.txt). It supplies the verified chemical background without tool names, coordinates or a fixed step sequence. These experimental sources do not prove every elementary curved arrow or the uniqueness of a microscopic catalytic pathway. Explicitly reported uncertainty remains a chemical incompleteness, rather than being hidden as layout success.

## Structure and route acceptance

The reference SMILES/SMARTS are inferred machine encodings checked locally with RDKit, rather than strings quoted from the papers. The implementation uses exact heavy-atom graph matching plus charge and total attached H counts, with explicit H folded in; it ignores stereochemical choice. The Michael-skeleton observation alone allows bond-order/charge changes for keto/enol/enolate representations.

| Species | Reference SMILES | Formula / rings |
|---|---|---|
| Starting dione | `CC1C(=O)CCCC1=O` | C7H10O2 / 6 |
| MVK | `C=CC(C)=O` | C4H6O |
| Michael trione | `CC1(CCC(C)=O)C(=O)CCCC1=O` | C11H16O3 / 6 |
| Aldol ketol, optional observation | `CC12CCC(=O)CC1(O)CCCC2=O` | C11H16O3 / 6,6 |
| Final Wieland–Miescher enedione | `CC12CCC(=O)C=C1CCCC2=O` | C11H14O2 / 6,6 |
| Rejected Hajos–Parrish analogue | `CC12CCC(=O)C=C1CCC2=O` | C10H12O2 / 5,6 |

The hard witnesses are both starting structures participating in a connected route through the Michael carbon skeleton to the exact neutral 6,6 enedione; a cross-molecule C–C attack before that skeleton; an intramolecular C–C carbonyl attack after it; and oxygen-base/pyrrolidine participation and release/regeneration on the target route. The KOH/methanol stage accepts hydroxide or methoxide as the drawn basic species. Free pyrrolidinium after acid workup also counts as release of the amine catalyst framework. These state allowances are chemical interpretation, not experimental speciation measurements. A separately drawn neutral aldol ketol is reported but is not mandatory: amine-bound intermediates and proton-transfer grouping can differ.

Each step must retain real electron-flow endpoints and actual `checkedArrowIds` coverage, including bond sources. Generic runtime chemistry checks, per-step layout checks, actual-curve `R.assessReadability`, route references, completion status and PNG/SVG/molwork exports still apply. These checks detect concrete omissions and wrong structures; they are not a proof of experimental selectivity, catalyst kinetics or every mechanistic inference.

## Commands

No-model reference/audit regression:

```sh
node --test fusion/tests/test_agent_robinson_audit.cjs
```

Explicitly authorised live acceptance, using the configured model and intended build:

```sh
MOLSTUDIO_REAL_AGENT=1 \
MOLSTUDIO_AGENT_LONG_CASE=ROBINSON \
MOLSTUDIO_PORT=49080 \
MOLSTUDIO_TEST_BUILD=/absolute/path/MolStudio.app \
MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts/robinson-live \
fusion/node_modules/.bin/electron fusion/tests/test_agent_long_route_live.cjs
```

`MOLSTUDIO_AGENT_LONG_PROMPT_FILE` remains available as a natural-task override. Case defaults have no preparation-branch or caffeine requirement and no multi-step count threshold beyond a nonempty route. The gateway request cap and watchdog remain the long harness's explicit limits. This document does not record a live-model pass.
