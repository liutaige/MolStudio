'use strict';
// Narrow-channel regression extracted from the real Robinson continuation's
// enamine aldol arrow ar-02ed46f4-0c3f-4395-ad09-d06c02eac0ef.
// Source: model-robinson-idle-diagnostic/report.json, saved 2026-11-12;
// build: .jez/artifacts/complex-route-repair-20261112/release-delivery/MolStudio.app.
// The report describes real-model continuation requests through the local model
// gateway, transport variant local-model-idle300-diagnostic. It does not record
// a model name. This fixture proves routing only, not a complete mechanism pass.
// IDs are local aliases; coordinates are only translated, native glyph boxes
// and all 18 atoms / 19 bonds in this reacting molecule are preserved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
const M = globalThis.MolWorkbench.model, R = globalThis.MolWorkbench.route;
const fixture = {
  "unit": 0.034722222222222224,
  "atoms": [
    {
      "id": "a0",
      "label": "O",
      "pos": {
        "x": 0.0,
        "y": 0.0
      }
    },
    {
      "id": "a1",
      "label": "C",
      "pos": {
        "x": 0.986860723763,
        "y": 0.169393258289
      }
    },
    {
      "id": "a2",
      "label": "C",
      "pos": {
        "x": 1.624135360762,
        "y": -0.60057609757
      }
    },
    {
      "id": "a3",
      "label": "C",
      "pos": {
        "x": 2.612296032789,
        "y": -0.430982847241
      }
    },
    {
      "id": "a4",
      "label": "C",
      "pos": {
        "x": 2.95638233844,
        "y": 0.507479802726
      }
    },
    {
      "id": "a5",
      "label": "C",
      "pos": {
        "x": 2.319107701441,
        "y": 1.277349162565
      }
    },
    {
      "id": "a6",
      "label": "O",
      "pos": {
        "x": 2.664593951375,
        "y": 2.21521183641
      }
    },
    {
      "id": "a7",
      "label": "C",
      "pos": {
        "x": 1.330847033394,
        "y": 1.107755912235
      }
    },
    {
      "id": "a8",
      "label": "C",
      "pos": {
        "x": 0.34768616238,
        "y": 1.285748828265
      }
    },
    {
      "id": "a9",
      "label": "C",
      "pos": {
        "x": 1.336846794609,
        "y": 2.107916106691
      }
    },
    {
      "id": "a10",
      "label": "C",
      "pos": {
        "x": 0.473481155843,
        "y": 2.612496024829
      }
    },
    {
      "id": "a11",
      "label": "C",
      "pos": {
        "x": -0.394484299853,
        "y": 2.116515764431
      }
    },
    {
      "id": "a12",
      "label": "C",
      "pos": {
        "x": -0.399084116784,
        "y": 1.116355569976
      }
    },
    {
      "id": "a13",
      "label": "N",
      "pos": {
        "x": -1.259049890861,
        "y": 2.62089569053
      }
    },
    {
      "id": "a14",
      "label": "C",
      "pos": {
        "x": -2.17381348403,
        "y": 2.216211796612
      }
    },
    {
      "id": "a15",
      "label": "C",
      "pos": {
        "x": -2.839886974858,
        "y": 2.962582091695
      }
    },
    {
      "id": "a16",
      "label": "C",
      "pos": {
        "x": -2.338006949266,
        "y": 3.827147682703
      }
    },
    {
      "id": "a17",
      "label": "C",
      "pos": {
        "x": -1.359045911102,
        "y": 3.615456107852
      }
    }
  ],
  "bonds": [
    {
      "id": "b0",
      "type": 2,
      "beginAtom": "a0",
      "endAtom": "a1"
    },
    {
      "id": "b1",
      "type": 1,
      "beginAtom": "a1",
      "endAtom": "a2"
    },
    {
      "id": "b2",
      "type": 1,
      "beginAtom": "a2",
      "endAtom": "a3"
    },
    {
      "id": "b3",
      "type": 1,
      "beginAtom": "a3",
      "endAtom": "a4"
    },
    {
      "id": "b4",
      "type": 1,
      "beginAtom": "a4",
      "endAtom": "a5"
    },
    {
      "id": "b5",
      "type": 2,
      "beginAtom": "a5",
      "endAtom": "a6"
    },
    {
      "id": "b6",
      "type": 1,
      "beginAtom": "a5",
      "endAtom": "a7"
    },
    {
      "id": "b7",
      "type": 1,
      "beginAtom": "a7",
      "endAtom": "a8"
    },
    {
      "id": "b8",
      "type": 1,
      "beginAtom": "a7",
      "endAtom": "a9"
    },
    {
      "id": "b9",
      "type": 1,
      "beginAtom": "a9",
      "endAtom": "a10"
    },
    {
      "id": "b10",
      "type": 1,
      "beginAtom": "a10",
      "endAtom": "a11"
    },
    {
      "id": "b11",
      "type": 2,
      "beginAtom": "a11",
      "endAtom": "a12"
    },
    {
      "id": "b12",
      "type": 1,
      "beginAtom": "a11",
      "endAtom": "a13"
    },
    {
      "id": "b13",
      "type": 1,
      "beginAtom": "a13",
      "endAtom": "a14"
    },
    {
      "id": "b14",
      "type": 1,
      "beginAtom": "a14",
      "endAtom": "a15"
    },
    {
      "id": "b15",
      "type": 1,
      "beginAtom": "a15",
      "endAtom": "a16"
    },
    {
      "id": "b16",
      "type": 1,
      "beginAtom": "a16",
      "endAtom": "a17"
    },
    {
      "id": "b17",
      "type": 1,
      "beginAtom": "a7",
      "endAtom": "a1"
    },
    {
      "id": "b18",
      "type": 1,
      "beginAtom": "a17",
      "endAtom": "a13"
    }
  ],
  "labels": {
    "a0": {
      "hasLabel": true,
      "rect": {
        "x1": -0.126409296126,
        "y1": -0.173611440495,
        "x2": 0.126411887079,
        "y2": 0.173610792324
      },
      "atomRect": {
        "x1": -0.126409296126,
        "y1": -0.173611440495,
        "x2": 0.126411887079,
        "y2": 0.173610792324
      },
      "hydrogenRects": [],
      "hwCss": 3.6406250381469927,
      "hhCss": 5.000000152587895
    },
    "a6": {
      "hasLabel": true,
      "rect": {
        "x1": 2.538182683854,
        "y1": 2.041601572201,
        "x2": 2.791003867059,
        "y2": 2.388823805019
      },
      "atomRect": {
        "x1": 2.538182683854,
        "y1": 2.041601572201,
        "x2": 2.791003867059,
        "y2": 2.388823805019
      },
      "hydrogenRects": [],
      "hwCss": 3.6406250381469927,
      "hhCss": 5.000000152587921
    },
    "a8": {
      "hasLabel": true,
      "rect": {
        "x1": -0.211861588091,
        "y1": 1.112136850521,
        "x2": 0.465145822435,
        "y2": 1.528803529903
      },
      "atomRect": {
        "x1": 0.230228277116,
        "y1": 1.112136850521,
        "x2": 0.465145822435,
        "y2": 1.45935908334
      },
      "hydrogenRects": [
        {
          "x1": -0.211861588091,
          "y1": 1.112136850521,
          "x2": 0.023055957227,
          "y2": 1.45935908334
        },
        {
          "x1": 0.042629424005,
          "y1": 1.181581297085,
          "x2": 0.223293498426,
          "y2": 1.528803529903
        }
      ],
      "hwCss": 9.74890671157837,
      "hhCss": 6.000000183105464
    },
    "a12": {
      "hasLabel": true,
      "rect": {
        "x1": -0.958632828326,
        "y1": 0.942744455502,
        "x2": -0.2816254178,
        "y2": 1.359411134884
      },
      "atomRect": {
        "x1": -0.516542963118,
        "y1": 0.942744455502,
        "x2": -0.2816254178,
        "y2": 1.28996668832
      },
      "hydrogenRects": [
        {
          "x1": -0.958632828326,
          "y1": 0.942744455502,
          "x2": -0.723715283007,
          "y2": 1.28996668832
        },
        {
          "x1": -0.704140290351,
          "y1": 1.012188902065,
          "x2": -0.52347621593,
          "y2": 1.359411134884
        }
      ],
      "hwCss": 9.74890671157837,
      "hhCss": 6.000000183105464
    },
    "a13": {
      "hasLabel": true,
      "rect": {
        "x1": -1.376508478255,
        "y1": 2.447285471127,
        "x2": -1.141590932936,
        "y2": 2.794507703945
      },
      "atomRect": {
        "x1": -1.376508478255,
        "y1": 2.447285471127,
        "x2": -1.141590932936,
        "y2": 2.794507703945
      },
      "hydrogenRects": [],
      "hwCss": 3.382812652587895,
      "hhCss": 5.0000001525878695
    }
  },
  "flow": {
    "electronCount": 2,
    "source": {
      "type": "bond",
      "bondId": "b11",
      "component": "pi"
    },
    "target": {
      "type": "formingBond",
      "atomA": "a12",
      "atomB": "a1"
    }
  }
};

function input() {
  const atoms = new Map(fixture.atoms.map(atom => [atom.id, atom]));
  const bonds = fixture.bonds.map(bond => ({ ...bond, uuid: bond.id,
    begin: atoms.get(bond.beginAtom).pos, end: atoms.get(bond.endAtom).pos }));
  const ctx = { atomPos: id => atoms.get(id)?.pos, bondInfo: id => bonds.find(bond => bond.id === id),
    atomLabelBox: id => fixture.labels[id] || { hasLabel: false }, unit: () => fixture.unit,
    atoms: () => fixture.atoms.map(atom => ({ ...atom, uuid: atom.id })), bonds: () => bonds };
  const geometry = bend => M.arrowGeometry({ ...fixture.flow, geometry: { bend } }, ctx);
  const base = geometry(0);
  return { a: base.routingStart || base.start, b: base.routingEnd || base.end,
    scene: R.buildScene(ctx, { state: { lonePairs: [], arrows: [] } }),
    source: fixture.flow.source, target: fixture.flow.target, electronCount: 2,
    targetDir: R.resolveTargetDir(fixture.flow.target, ctx, base.end), geometry, preferClearArrows: true };
}

test('adaptive refinement finds the real Robinson channel without relaxing native obstacles', () => {
  const request = input();
  const coarse = R.planArrow({ ...request, opts: { maxRefinementCandidates: 0 } });
  assert.equal(coarse.feasible, false);
  assert.equal(coarse.feasibleCount, 0);
  for (const [bend, atomId] of [[-0.5, 'a8'], [-0.66, 'a0']]) {
    const fixedGeometry = request.geometry(bend);
    const fixed = R.planArrow({ ...request, fixedGeometry });
    assert.equal(fixed.feasible, false);
    assert.ok(fixed.collisions.labels.includes(atomId), 'opposite corridor edges retain their actual label collisions');
    assert.equal(fixed.count, 1, 'fixed assessment never searches for a substitute curve');
    assert.equal(fixed.refinementCount, 0);
  }
  const refined = R.planArrow(request);
  assert.equal(refined.feasible, true);
  assert.equal(refined.readable, true);
  assert.ok(refined.bend >= -0.66 && refined.bend <= -0.51, 'selected arc lies in the independently densely sampled corridor');
  assert.deepEqual(refined.collisions, { labels: [], bonds: [] });
  assert.ok(refined.refinementCount > 0 && refined.refinementCount <= R.DEFAULTS.maxRefinementCandidates);
  assert.ok(refined.count <= R.DEFAULTS.maxCandidates + R.DEFAULTS.maxRefinementCandidates);
  const fixed = R.planArrow({ ...request, fixedGeometry: request.geometry(refined.bend) });
  assert.equal(fixed.feasible, true, 'the actual selected curve clears the unchanged native scene');
  assert.equal(fixed.readable, true);
  assert.deepEqual(R.planArrow(request), refined, 'refinement is deterministic');
});

test('ordinary clear routes retain their coarse candidate budget and do not refine', () => {
  const request = input();
  request.scene = { labels: [], bonds: [], lonePairs: [], arrows: [], L: 1 };
  const result = R.planArrow(request);
  assert.equal(result.feasible, true);
  assert.equal(result.readable, true);
  assert.equal(result.refinementCount, 0);
  assert.ok(result.count <= R.DEFAULTS.maxCandidates);
});
