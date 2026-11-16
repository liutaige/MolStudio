#!/usr/bin/env python3
"""Conservative cleanup: local geometry, persistent identities and API defaults."""
from __future__ import annotations
import copy
import json
import math
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import conservative_layout
import server
import stereo
from rdkit import Chem

FIX = Path(__file__).parent / 'fixtures'


def load():
    return json.loads((FIX / 'conservative-electrophilic-bromination.ket').read_text())


def apply(doc, result):
    candidate = copy.deepcopy(doc)
    for molecule in result['molecules']:
        section = candidate[molecule['key']]
        for atom, p in zip(section['atoms'], molecule['atoms']):
            atom['location'] = [*p, 0]
        for bond, update in zip(section.get('bonds', []), molecule['bonds']):
            bond['atoms'] = [update['i'], update['j']]
            if update['stereo']:
                bond['stereo'] = update['stereo']
            else:
                bond.pop('stereo', None)
    return candidate


def error(section):
    lengths = [math.dist(section['atoms'][i]['location'][:2], section['atoms'][j]['location'][:2]) for i, j in (b['atoms'] for b in section['bonds'])]
    return sum((length - 1) ** 2 for length in lengths)


def sketch(points, edges, scale=1):
    return {'type': 'molecule',
            'atoms': [{'label': 'C', 'location': [x*scale, y*scale, 0]} for x, y in points],
            'bonds': [{'type': 1, 'atoms': list(edge)} for edge in edges]}


def median_length(points, edges):
    return conservative_layout.statistics.median(math.dist(points[i], points[j]) for i, j in edges)


class ConservativeLayoutTest(unittest.TestCase):
    def test_complete_mechanism_retains_positions_and_explicit_substituent_sides(self):
        doc = load()
        result = conservative_layout.layout_ket(json.dumps(doc))
        self.assertEqual(result['mode'], 'preserve')
        self.assertEqual(apply(doc, result), doc)
        self.assertTrue(all(not r['report']['changed'] for r in result['molecules']))
        for _ in range(3):
            result = conservative_layout.layout_ket(json.dumps(apply(doc, result)))
            self.assertEqual(apply(doc, result), doc)
        sigma = doc['sigma']
        self.assertLess(sigma['atoms'][7]['location'][0], sigma['atoms'][0]['location'][0])
        self.assertGreater(sigma['atoms'][6]['location'][0], sigma['atoms'][0]['location'][0])

    def test_small_sketch_error_improves_with_bounded_motion_and_stable_bonds(self):
        doc = load()
        doc['benzene']['atoms'][3]['location'][0] += .08
        doc['benzene']['atoms'][3]['location'][1] += .04
        old = copy.deepcopy(doc)
        result = conservative_layout.layout_ket(json.dumps(doc))
        candidate = apply(doc, result)
        self.assertLess(error(candidate['benzene']), error(doc['benzene']) * .1)
        self.assertLess(max(math.dist(a['location'], b['location']) for a, b in zip(doc['benzene']['atoms'],candidate['benzene']['atoms'])), .18)
        self.assertEqual(candidate['sigma'], old['sigma'])
        self.assertEqual(candidate['hbr'], old['hbr'])
        self.assertEqual(candidate['root'], old['root'])
        self.assertEqual(candidate['benzene']['bonds'], old['benzene']['bonds'])
        for before, after in zip(conservative_layout._center([a['location'] for a in old['benzene']['atoms']]), conservative_layout._center([a['location'] for a in candidate['benzene']['atoms']])):
            self.assertAlmostEqual(before, after, places=12)
        repeat = conservative_layout.layout_ket(json.dumps(candidate))
        self.assertEqual(apply(candidate, repeat), candidate)

    def test_repeated_cleanup_is_stable_for_five_to_eight_membered_rings(self):
        samples = []
        for count in [5, 6, 7, 8]:
            radius = 1 / (2 * math.sin(math.pi / count))
            points = [[radius * math.cos(i * 2 * math.pi / count), radius * math.sin(i * 2 * math.pi / count)] for i in range(count)]
            points[0][0] += .08
            points[0][1] += .04
            samples.append(points)
        # Independent review reproduction: per-click bounds alone allowed a
        # heptagon to drift .2656 original bond lengths over four clicks.
        samples.append([[.966216,-.061123],[.624247,.828135],[-.210715,1.084828],[-1.018552,.376341],[-.801189,-.354915],[-.29412,-.8845],[.511803,-.886322]])
        for points in samples:
            for scale in [.5, 1, 2]:
                count = len(points)
                original = {"type":"molecule", "atoms":[{"label":"C", "location":[x*scale, y*scale, 0]} for x,y in points],
                            "bonds":[{"type":1,"atoms":[i,(i+1)%count]} for i in range(count)]}
                initial = [atom['location'][:2] for atom in original['atoms']]
                lengths = sorted(math.dist(initial[i], initial[(i+1)%count]) for i in range(count))
                median = (lengths[count//2] if count % 2 else (lengths[count//2-1] + lengths[count//2]) / 2)
                result = conservative_layout.layout_section(original)
                self.assertTrue(result['report']['changed'], (count, scale, result['report']))
                self.assertLess(max(math.dist(a,b) for a,b in zip(initial,result['atoms'])), .5 * median)
                candidate = copy.deepcopy(original)
                for atom, xy in zip(candidate['atoms'], result['atoms']):
                    atom['location'] = [*xy,0]
                for click in range(3):
                    repeat = conservative_layout.layout_section(candidate)
                    self.assertEqual(repeat['atoms'], result['atoms'], (count,scale,click))
                    self.assertFalse(repeat['report']['changed'])

    def test_selected_component_only_and_independent_scales(self):
        for scale in [.5, 2]:
            doc = load()
            for a in doc['sigma']['atoms']:
                a['location'][:2] = [8 + (a['location'][0] - 8) * scale, a['location'][1] * scale]
            result = conservative_layout.layout_ket(json.dumps(doc), points=[doc['sigma']['atoms'][0]['location'][:2]])
            self.assertEqual(result['targets'], ['sigma'])
            self.assertEqual(result['molecules'][0]['coordinateScale'], 'preserved')
            self.assertEqual(apply(doc, result), doc)

    def test_stereo_identity_and_user_wedges_are_never_reassigned(self):
        for fixture in ['M03','M05','M07','M08','M10','M11','M12','W01','W04','W05']:
            doc = json.loads((FIX / (fixture+'.ket')).read_text())
            result = conservative_layout.layout_ket(json.dumps(doc))
            candidate = apply(doc, result)
            for key in result['targets']:
                old, new = doc[key], candidate[key]
                self.assertEqual(old.get('bonds'), new.get('bonds'), fixture)
                self.assertEqual([dict(a, location=None) for a in old['atoms']], [dict(a, location=None) for a in new['atoms']], fixture)
                self.assertEqual(Chem.MolToSmiles(stereo.mol_from_section(old)), Chem.MolToSmiles(stereo.mol_from_section(new)), fixture)

    def test_dragged_atom_receives_useful_repair_without_old_motion_cutoff(self):
        doc = load()
        doc['benzene']['atoms'][3]['location'][0] += .8
        result = conservative_layout.layout_ket(json.dumps(doc))
        candidate = apply(doc, result)
        self.assertTrue(result['molecules'][0]['report']['changed'])
        self.assertLess(error(candidate['benzene']), error(doc['benzene']) * .05)
        self.assertGreater(result['molecules'][0]['report']['maxDisplacement'], .18)
        self.assertEqual(candidate['sigma'], doc['sigma'])
        self.assertEqual(apply(candidate, conservative_layout.layout_ket(json.dumps(candidate))), candidate)

    def test_equal_bond_right_angle_chain_is_corrected_at_independent_scales(self):
        for scale in [.5, 1, 2]:
            section = sketch([[0, 0], [1, 0], [1, 1]], [(0, 1), (1, 2)], scale)
            result = conservative_layout.layout_section(section)
            self.assertTrue(result['report']['changed'])
            self.assertLess(abs(math.degrees(abs(conservative_layout._angle(result['atoms'], 1, 0, 2))) - 120), .1)
            self.assertLess(result['report']['maxDisplacement'], .25 * scale)
            self.assertGreater(result['report']['maxDisplacement'], .18 * scale)
            self.assertLess(abs(median_length(result['atoms'], [(0, 1), (1, 2)]) / scale - 1), .001)
            for a, b in zip(conservative_layout._center(result['atoms']), conservative_layout._center([a['location'] for a in section['atoms']])):
                self.assertAlmostEqual(a, b, places=12)
            self.assert_stable(section, result)

    def test_t_shaped_branch_and_rotated_perturbations_receive_stable_repair(self):
        edges = [(0, 1), (0, 2), (0, 3)]
        for degrees in [0, 17, 90, 180, 251]:
            theta = math.radians(degrees)
            for offset in [0, -.01, .01, -1e-10, 1e-10]:
                points = [[0, 0], [-1, 0], [0, 1], [1, offset]]
                points = [[x*math.cos(theta)-y*math.sin(theta), x*math.sin(theta)+y*math.cos(theta)] for x, y in points]
                section = sketch(points, edges)
                result = conservative_layout.layout_section(section)
                self.assertTrue(result['report']['changed'], (degrees, offset, result['report']))
                report = result['report']['components'][0]
                self.assertLess(report['quality']['maxAngleError'], 2)
                self.assertLess(report['quality']['maxBondError'], .025)
                self.assertLess(result['report']['maxDisplacement'], .7)
                self.assertTrue(conservative_layout._preserves_sides(points, result['atoms'], edges))
                self.assert_stable(section, result)

    def test_many_collinear_branch_centers_do_not_require_candidate_enumeration(self):
        # Ten independent T centres in one KET section exercise the same path
        # without trying the 2**10 combinations of independent signed-zero rays.
        points, edges = [], []
        for n in range(10):
            base = len(points)
            points.extend([[4*n, 0], [4*n-1, 0], [4*n, 1], [4*n+1, 0]])
            edges.extend([(base, base+1), (base, base+2), (base, base+3)])
        section = sketch(points, edges)
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'])
        self.assertTrue(all(r['status'] == 'adjusted' for r in result['report']['components']))
        self.assert_stable(section, result)

    def test_unequal_bonds_and_near_overlapping_atoms_are_repaired(self):
        # Previously the small nonbonded spacing caused an unconditional early exit.
        section = sketch([[0, 0], [1, 0], [.02, .1]], [(0, 1), (1, 2)])
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'], result['report'])
        quality = result['report']['components'][0]['quality']
        self.assertLess(quality['maxBondError'], .025)
        self.assertLess(quality['maxAngleError'], 2)
        self.assertGreater(quality['minNonBonded'], 1.7)
        self.assert_stable(section, result)

    def test_equal_length_irregular_ring_receives_angle_correction(self):
        t = math.sqrt(.5)
        points = [[0, 0], [1, 0], [1+t, t], [1, 2*t], [0, 2*t], [-t, t]]
        edges = [(i, (i+1) % 6) for i in range(6)]
        section = sketch(points, edges)
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'], result['report'])
        report = result['report']['components'][0]
        self.assertLess(report['qualityBefore']['maxBondError'], 1e-12)
        self.assertGreater(report['qualityBefore']['maxAngleError'], 10)
        self.assertLess(report['quality']['maxAngleError'], 2)
        self.assert_stable(section, result)

    def test_ordinary_dragged_ring_keeps_center_scale_and_reduces_error(self):
        for scale in [.5, 1, 2]:
            points = [[math.cos(i*math.pi/3), math.sin(i*math.pi/3)] for i in range(6)]
            points[0][0] += .32
            points[0][1] -= .18
            edges = [(i, (i+1) % 6) for i in range(6)]
            section = sketch(points, edges, scale)
            before = [a['location'][:2] for a in section['atoms']]
            result = conservative_layout.layout_section(section)
            length = median_length(before, edges)
            self.assertTrue(result['report']['changed'], result['report'])
            self.assertLess(sum((math.dist(result['atoms'][i], result['atoms'][j]) / length - 1)**2 for i, j in edges),
                            sum((math.dist(before[i], before[j]) / length - 1)**2 for i, j in edges) * .05)
            self.assertLess(abs(median_length(result['atoms'], edges) / length - 1), .001)
            for a, b in zip(conservative_layout._center(before), conservative_layout._center(result['atoms'])):
                self.assertAlmostEqual(a, b, places=12)
            self.assert_stable(section, result)

    def test_ambiguous_crossed_ring_is_retained_with_honest_reason(self):
        section = sketch([[0, 0], [1, 1], [0, 1], [1, 0]], [(0, 1), (1, 2), (2, 3), (3, 0)])
        doc = {'root': {'nodes': [{'$ref': 'mol0'}]}, 'mol0': section}
        result = conservative_layout.layout_ket(json.dumps(doc))
        self.assertFalse(result['molecules'][0]['report']['changed'])
        self.assertEqual(apply(doc, result), doc)
        self.assertEqual(result['warnings'][0]['code'], 'ambiguous_atom_sides')

    def test_crossing_detection_and_reports_are_invariant_under_molecular_scale(self):
        points = [[0, 0], [1, 0], [.8660254, .5], [-.8660254, .5], [0, -1],
                  [.1339746, .5], [1.8660254, .5], [1, -1]]
        edges = [(0, 1), (0, 2), (0, 3), (0, 4), (1, 5), (1, 6), (1, 7)]
        for scale in [1, .5, .05, .01, .001]:
            section = sketch(points, edges, scale)
            old = [a['location'][:2] for a in section['atoms']]
            self.assertTrue(conservative_layout._has_crossings(old, edges), scale)
            result = conservative_layout.layout_section(section)
            self.assertFalse(result['report']['changed'], (scale, result['report']))
            component = result['report']['components'][0]
            self.assertEqual(component['status'], 'retained', scale)
            self.assertTrue(component['quality']['crossings'], (scale, component))
            self.assertEqual(result['atoms'], old)

    def test_component_requiring_retention_does_not_block_an_independent_repair(self):
        section = sketch([[0, 0], [1, 0], [1, 1], [5, 0], [6, 1], [5, 1], [6, 0]],
                         [(0, 1), (1, 2), (3, 4), (4, 5), (5, 6), (6, 3)])
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'])
        self.assertEqual(result['atoms'][3:], [a['location'][:2] for a in section['atoms'][3:]])
        self.assertEqual([r['status'] for r in result['report']['components']], ['adjusted', 'retained'])
        self.assert_stable(section, result)

    def test_single_bond_retains_its_own_drawing_scale_and_zero_bond_is_reported(self):
        for scale in [.5, 2]:
            section = sketch([[0, 0], [1, 0]], [(0, 1)], scale)
            result = conservative_layout.layout_section(section)
            self.assertFalse(result['report']['changed'])
            self.assertEqual(result['atoms'], [a['location'][:2] for a in section['atoms']])
        degenerate = conservative_layout.layout_section(sketch([[0, 0], [0, 0]], [(0, 1)]))
        self.assertEqual(degenerate['report']['components'][0]['reason'], 'degenerate_bond')

    def test_repair_preserves_explicit_substituent_sides_and_user_bonds(self):
        section = copy.deepcopy(load()['sigma'])
        section['atoms'][3]['location'][0] += .32
        section['atoms'][3]['location'][1] -= .18
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'], result['report'])
        self.assertLess(result['atoms'][7][0], result['atoms'][0][0])
        self.assertGreater(result['atoms'][6][0], result['atoms'][0][0])
        self.assert_stable(section, result)

    def test_near_collinear_four_connected_explicit_hbr_never_exchange_sides(self):
        edges = [(0, i) for i in range(1, 5)]
        original = [[0, 0], [1, 0], [-1, .01], [0, 2], [0, -1]]
        for rotation in [0, math.radians(80)]:
            points = [[x * math.cos(rotation) - y * math.sin(rotation),
                       x * math.sin(rotation) + y * math.cos(rotation)] for x, y in original]
            for scale in [.001, .5, 1, 2]:
                section = sketch(points, edges, scale)
                section['atoms'][1]['label'] = 'H'
                section['atoms'][2]['label'] = 'Br'
                result = conservative_layout.layout_section(section)
                self.assertFalse(result['report']['changed'], (rotation, scale, result))
                self.assertEqual(result['atoms'], [a['location'][:2] for a in section['atoms']])
                self.assertEqual(result['report']['components'][0]['reason'], 'ambiguous_atom_sides')

    def assert_stable(self, section, result):
        candidate = copy.deepcopy(section)
        for atom, xy in zip(candidate['atoms'], result['atoms']):
            atom['location'] = [*xy, 0]
        repeat = conservative_layout.layout_section(candidate)
        self.assertFalse(repeat['report']['changed'], repeat['report'])
        self.assertEqual(repeat['atoms'], result['atoms'])
        self.assertEqual(candidate['bonds'], section['bonds'])
        self.assertEqual([dict(a, location=None) for a in candidate['atoms']],
                         [dict(a, location=None) for a in section['atoms']])
        self.assertEqual(Chem.MolToSmiles(stereo.mol_from_section(candidate)),
                         Chem.MolToSmiles(stereo.mol_from_section(section)))

    def test_http_handler_defaults_to_preserve_even_with_old_compact_flag(self):
        doc = load()
        for options in [{}, {'compact':True}, {'mode':'preserve'}]:
            result = server.Handler._api_layout(SimpleNamespace(_payload={'ket':json.dumps(doc),**options}), '')
            self.assertEqual(apply(doc,result), doc)
            self.assertEqual(result['coordinateScale'], 'preserved')
        legacy = server.Handler._api_layout(SimpleNamespace(_payload={'ket':json.dumps(doc),'mode':'rebuild','compact':False}), '')
        self.assertNotIn('coordinateScale',legacy)
        self.assertNotEqual(apply(doc,legacy),doc)

    def test_four_connected_dragged_bond_and_ketcher_star_are_cleaned_to_tetrahedral(self):
        edges = [(0, 1), (1, 2), (1, 3), (1, 4)]
        live_points = [
            [5.466987298107781, -6.7],
            [6.33301270189222, -6.2],
            [7.199038105676658, -6.700000000000001],
            [6.333012701892221, -5.2],
            [9.50479568956845, -4.194676696165978],
        ]
        ketcher_points = live_points[:4] + [[7.199038105676658, -5.7]]
        cross_points = [[-1, 0], [0, 0], [1, 0], [0, 1], [0, -1]]
        for points in (live_points, ketcher_points, cross_points):
            section = sketch(points, edges)
            result = conservative_layout.layout_section(section)
            self.assertTrue(result['report']['changed'], result['report'])
            component = result['report']['components'][0]
            self.assertEqual(component['status'], 'adjusted')
            self.assertLess(component['quality']['maxBondError'], 0.025)
            self.assertLess(component['quality']['maxAngleError'], 2.0)
            gaps = stereo.center_gaps(result['atoms'], edges)
            self.assertEqual(sorted(gaps[0]['gaps']), [60.0, 90.0, 90.0, 120.0])
            angles = sorted(
                math.degrees(math.atan2(result['atoms'][i][1] - result['atoms'][1][1],
                                        result['atoms'][i][0] - result['atoms'][1][0]))
                for i in (0, 2, 3, 4)
            )
            for got, expected in zip(angles, (-150.0, -30.0, 60.0, 120.0)):
                self.assertAlmostEqual(got, expected, delta=1.0)
            self.assert_stable(section, result)

        sigma = copy.deepcopy(load()['sigma'])
        sigma['atoms'][7]['location'][0] -= 2.0
        sigma['atoms'][7]['location'][1] += 1.5
        sigma_result = conservative_layout.layout_section(sigma)
        self.assertTrue(sigma_result['report']['changed'], sigma_result['report'])
        self.assertEqual(sigma_result['report']['components'][0]['status'], 'adjusted')
        self.assertLess(sigma_result['atoms'][7][0], sigma_result['atoms'][0][0])
        self.assertGreater(sigma_result['atoms'][6][0], sigma_result['atoms'][0][0])
        self.assert_stable(sigma, sigma_result)

    def test_ring_substituent_drawn_inside_ring_flips_outside_cleanly(self):
        section = {
            'type': 'molecule',
            'atoms': [
                {'label': 'C', 'location': [6.384849152128566, -10.380020056798138, 0]},
                {'label': 'C', 'location': [7.2538208554795585, -10.875033111149811, 0]},
                {'label': 'C', 'location': [7.251637509491239, -8.874966888850187, 0]},
                {'label': 'C', 'location': [8.981408950575881, -8.874992492299459, 0]},
                {'label': 'C', 'location': [8.115150847871433, -9.374589229177204, 0]},
                {'label': 'C', 'location': [6.384849152128566, -9.375074417174607, 0]},
                {'label': 'C', 'location': [7.248892745166986, -9.874185966054949, 0]},
                {'label': 'C', 'location': [8.115150847871433, -10.375532067822148, 0]},
            ],
            'bonds': [
                {'type': 2, 'atoms': [2, 5]},
                {'type': 1, 'atoms': [5, 0]},
                {'type': 2, 'atoms': [0, 1]},
                {'type': 1, 'atoms': [1, 7]},
                {'type': 1, 'atoms': [7, 4]},
                {'type': 1, 'atoms': [4, 2]},
                {'type': 1, 'atoms': [4, 3]},
                {'type': 1, 'atoms': [4, 6]},
            ],
        }
        result = conservative_layout.layout_section(section)
        self.assertTrue(result['report']['changed'], result['report'])
        self.assertEqual(result['report']['components'][0]['status'], 'adjusted')
        center_x = result['atoms'][4][0]
        self.assertGreater(result['atoms'][3][0], center_x)
        self.assertGreater(result['atoms'][6][0], center_x)
        sub_angle = abs(math.degrees(conservative_layout._angle(result['atoms'], 4, 3, 6)))
        self.assertAlmostEqual(sub_angle, 60.0, delta=1.0)
        self.assert_stable(section, result)

    def test_disconnected_section_keeps_component_centers_and_scales(self):
        section = copy.deepcopy(load()['benzene'])
        other = copy.deepcopy(load()['sigma'])
        base = len(section['atoms'])
        section['atoms'].extend(other['atoms'])
        section['bonds'].extend([dict(b, atoms=[i+base for i in b['atoms']]) for b in other['bonds']])
        result = conservative_layout.layout_section(section)
        self.assertEqual(result['atoms'], [a['location'][:2] for a in section['atoms']])


if __name__ == '__main__':
    unittest.main()
