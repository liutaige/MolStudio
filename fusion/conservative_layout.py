"""Identity-preserving cleanup of existing KET coordinates.

Geometry is fitted to the existing atom indices.  No depiction generator,
graph matching, mirror operation or inter-molecule packing is used.
"""
from __future__ import annotations

import copy
import json
import math
import statistics

import numpy as np
from rdkit import Chem

import stereo

_LENGTH_TOLERANCE = 0.025
_ANGLE_TOLERANCE = math.radians(2)


def _center(points):
    return tuple((min(p[k] for p in points) + max(p[k] for p in points)) / 2 for k in (0, 1))


def _components(count, edges):
    adjacent = [[] for _ in range(count)]
    for i, j in edges:
        adjacent[i].append(j)
        adjacent[j].append(i)
    seen = set()
    for seed in range(count):
        if seed in seen:
            continue
        ids, todo = [], [seed]
        seen.add(seed)
        while todo:
            i = todo.pop()
            ids.append(i)
            for j in adjacent[i]:
                if j not in seen:
                    seen.add(j)
                    todo.append(j)
        yield sorted(ids)


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _has_crossings(points, edges):
    if not edges:
        return False
    # Cross-product thresholds have units of length**4. Evaluate orientations
    # in bond-length units so the same drawing receives the same decision after
    # a document scale edit, including very small imported drawings.
    length = statistics.median(math.dist(points[i], points[j]) for i, j in edges)
    if length <= 0:
        return False

    def orientation(a, b, c):
        ab = [(points[b][k] - points[a][k]) / length for k in (0, 1)]
        ac = [(points[c][k] - points[a][k]) / length for k in (0, 1)]
        return ab[0] * ac[1] - ab[1] * ac[0]

    for n, (a, b) in enumerate(edges):
        for c, d in edges[n + 1:]:
            if len({a, b, c, d}) < 4:
                continue
            if (orientation(a, b, c) * orientation(a, b, d) < -1e-8 and
                    orientation(c, d, a) * orientation(c, d, b) < -1e-8):
                return True
    return False


def _interior_ring_flip_info(old, adjacent, angles):
    by_center = {}
    for center, j, k, theta in angles:
        by_center.setdefault(center, []).append((j, k, theta))
    allowed_flips = set()
    canon_cycles = {}
    for center, local in by_center.items():
        degree = len(adjacent[center])
        if degree not in (3, 4) or len(local) != degree:
            continue
        if abs(sum(theta for _, _, theta in local) - 2 * math.pi) > 1e-6:
            continue
        if any(local[m][1] != local[(m + 1) % degree][0] for m in range(degree)):
            continue
        r1, r2 = local[0][0], local[0][1]
        if len(adjacent[r1]) <= 1 or len(adjacent[r2]) <= 1:
            continue
        if _cross(old[center], old[r1], old[r2]) <= 0:
            continue
        interior_subs = []
        for s in adjacent[center]:
            if s in (r1, r2):
                continue
            n1 = math.dist(old[center], old[r1]) * math.dist(old[center], old[s])
            n2 = math.dist(old[center], old[s]) * math.dist(old[center], old[r2])
            if _cross(old[center], old[r1], old[s]) >= -1e-6 * n1 and _cross(old[center], old[s], old[r2]) >= -1e-6 * n2:
                interior_subs.append(s)
        if not interior_subs or any(len(adjacent[s]) != 1 for s in interior_subs):
            continue
        for s in interior_subs:
            allowed_flips.add((min(center, s), max(center, s)))
        canon_cycles[center] = [j for j, _, _ in local]
    return allowed_flips, canon_cycles


def _preserves_sides(old, new, edges, angles=()):
    adjacent = [[] for _ in old]
    for i, j in edges:
        adjacent[i].append(j)
        adjacent[j].append(i)
    allowed_flips, canon_cycles = _interior_ring_flip_info(old, adjacent, angles)
    for i, j in edges:
        if (min(i, j), max(i, j)) in allowed_flips:
            continue
        ox, oy = old[j][0] - old[i][0], old[j][1] - old[i][1]
        nx, ny = new[j][0] - new[i][0], new[j][1] - new[i][1]
        # A local fit can straighten a badly drawn angle, but cannot reverse a
        # bond or exchange explicit substituents around their common atom.
        if ox * nx + oy * ny <= 0:
            return False
    for i, neighbors in enumerate(adjacent):
        if i in canon_cycles:
            canon = canon_cycles[i]
            for m in range(len(canon)):
                a, b = canon[m], canon[(m + 1) % len(canon)]
                new_norm = math.dist(new[i], new[a]) * math.dist(new[i], new[b])
                if _cross(new[i], new[a], new[b]) <= 1e-6 * new_norm:
                    return False
            continue
        if len(neighbors) == 4:
            for k, j in enumerate(neighbors):
                for h in neighbors[k + 1:]:
                    before = _cross(old[i], old[j], old[h])
                    norm = math.dist(old[i], old[j]) * math.dist(old[i], old[h])
                    dot = sum((old[j][axis] - old[i][axis]) * (old[h][axis] - old[i][axis]) for axis in (0, 1))
                    if dot < 0 and 1e-6 * norm < abs(before) <= math.sin(_ANGLE_TOLERANCE) * norm:
                        return False
            ordered = sorted(neighbors, key=lambda j: math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]))
            for m in range(4):
                a, b = ordered[m], ordered[(m + 1) % 4]
                old_norm = math.dist(old[i], old[a]) * math.dist(old[i], old[b])
                new_norm = math.dist(new[i], new[a]) * math.dist(new[i], new[b])
                if _cross(old[i], old[a], old[b]) <= 1e-6 * old_norm or _cross(new[i], new[a], new[b]) <= 1e-6 * new_norm:
                    return False
            continue
        for k, j in enumerate(neighbors):
            for h in neighbors[k + 1:]:
                before = _cross(old[i], old[j], old[h])
                after = _cross(new[i], new[j], new[h])
                norm = math.dist(old[i], old[j]) * math.dist(old[i], old[h])
                dot = sum((old[j][axis] - old[i][axis]) * (old[h][axis] - old[i][axis]) for axis in (0, 1))
                # Only a near-180-degree pair at a three-connected T junction
                # needs the tolerant angle branch.
                tolerance = math.sin(_ANGLE_TOLERANCE) if len(neighbors) == 3 and dot < 0 else 1e-6
                if abs(before) > tolerance * norm and before * after <= 0:
                    return False
    return not _has_crossings(new, edges)


def _four_connected_tetrahedral_sector(old, i, ordered, gaps, adjacent):
    best_m, best_score = 0, None
    for m in range(4):
        a, b, c, d = [ordered[(m + k) % 4] for k in range(4)]
        gap_cost = (
            (gaps[m] - 2 * math.pi / 3) ** 2
            + (gaps[(m + 1) % 4] - math.pi / 2) ** 2
            + (gaps[(m + 2) % 4] - math.pi / 3) ** 2
            + (gaps[(m + 3) % 4] - math.pi / 2) ** 2
        )
        chain_bonus = 0.2 * ((len(adjacent[a]) > 1) + (len(adjacent[b]) > 1) - (len(adjacent[c]) > 1) - (len(adjacent[d]) > 1))
        va = [old[a][0] - old[i][0], old[a][1] - old[i][1]]
        vb = [old[b][0] - old[i][0], old[b][1] - old[i][1]]
        na, nb = max(math.hypot(*va), 1e-12), max(math.hypot(*vb), 1e-12)
        mid = math.atan2(va[1] / na + vb[1] / nb, va[0] / na + vb[0] / nb)
        orient_bonus = 0.15 * abs(math.sin(mid))
        score = gap_cost - chain_bonus - orient_bonus
        if best_score is None or score < best_score:
            best_score = score
            best_m = m
    return best_m


def _angle_constraints(mol, edges, old):
    """Chemical angle targets, without imposing a whole-molecule direction grid.

    Small rings retain their size. Ordinary two/three-connected atoms use the
    conventional 2D 120-degree drawing (180 degrees for sp atoms). Four-connected
    non-ring centres use the tetrahedral [120, 90, 60, 90] projection while
    preserving circular substituent order.
    """
    adjacent = [[] for _ in range(mol.GetNumAtoms())]
    for i, j in edges:
        adjacent[i].append(j)
        adjacent[j].append(i)
    ring_angles = {}
    for ring in mol.GetRingInfo().AtomRings():
        if not 3 <= len(ring) <= 8:
            continue
        for n, i in enumerate(ring):
            pair = tuple(sorted((ring[n - 1], ring[(n + 1) % len(ring)])))
            key = (i, *pair)
            theta = math.pi * (len(ring) - 2) / len(ring)
            ring_angles[key] = min(theta, ring_angles.get(key, theta))
    result = []
    for i, neighbors in enumerate(adjacent):
        local_ring = {key: theta for key, theta in ring_angles.items() if key[0] == i}
        if len(local_ring) == 1 and len(neighbors) in (3, 4):
            ring_key, ring_theta = next(iter(local_ring.items()))
            r1, r2 = ring_key[1], ring_key[2]
            if _cross(old[i], old[r1], old[r2]) < 0:
                r1, r2 = r2, r1
            ang_r1 = math.atan2(old[r1][1] - old[i][1], old[r1][0] - old[i][0])
            ang_r2 = math.atan2(old[r2][1] - old[i][1], old[r2][0] - old[i][0])
            ext_bisector = ang_r2 + ((ang_r1 - ang_r2) % (2 * math.pi)) / 2
            if len(neighbors) == 4:
                ordered = sorted(neighbors, key=lambda j: math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]))
                polar = [math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]) for j in ordered]
                gaps = [(polar[(m + 1) % 4] - polar[m]) % (2 * math.pi) for m in range(4)]
                ring_pair = {r1, r2}
                ring_idx = next((m for m in range(4) if {ordered[m], ordered[(m + 1) % 4]} == ring_pair), None)
                if ring_idx is not None:
                    sub_gap = gaps[(ring_idx + 2) % 4]
                    if math.radians(58) <= sub_gap <= math.radians(92) and abs(gaps[(ring_idx + 1) % 4] - gaps[(ring_idx + 3) % 4]) <= math.radians(4):
                        target_sub = sub_gap
                    else:
                        target_sub = math.pi / 3
                    side = (2 * math.pi - ring_theta - target_sub) / 2
                    targets = [0.0] * 4
                    targets[ring_idx] = ring_theta
                    targets[(ring_idx + 1) % 4] = side
                    targets[(ring_idx + 2) % 4] = target_sub
                    targets[(ring_idx + 3) % 4] = side
                    for n in range(4):
                        result.append((i, ordered[n], ordered[(n + 1) % 4], targets[n]))
                    continue
                subs = [u for u in neighbors if u not in (r1, r2)]
                interior_subs = [
                    u for u in subs
                    if _cross(old[i], old[r1], old[u]) >= -1e-6 * math.dist(old[i], old[r1]) * math.dist(old[i], old[u])
                    and _cross(old[i], old[u], old[r2]) >= -1e-6 * math.dist(old[i], old[u]) * math.dist(old[i], old[r2])
                ]
                if interior_subs and all(len(adjacent[u]) == 1 for u in interior_subs):
                    subs.sort(key=lambda u: (_wrap(math.atan2(old[u][1] - old[i][1], old[u][0] - old[i][0]) - ext_bisector), u))
                    s_first, s_second = subs
                    target_sub = math.pi / 3
                    side = (2 * math.pi - ring_theta - target_sub) / 2
                    canon = (r1, r2, s_first, s_second)
                    canon_targets = (ring_theta, side, target_sub, side)
                    for n in range(4):
                        result.append((i, canon[n], canon[(n + 1) % 4], canon_targets[n]))
                    continue
            else:
                s = next(u for u in neighbors if u not in (r1, r2))
                if (
                    len(adjacent[s]) == 1
                    and _cross(old[i], old[r1], old[s]) >= -1e-6 * math.dist(old[i], old[r1]) * math.dist(old[i], old[s])
                    and _cross(old[i], old[s], old[r2]) >= -1e-6 * math.dist(old[i], old[s]) * math.dist(old[i], old[r2])
                ):
                    side = (2 * math.pi - ring_theta) / 2
                    canon = (r1, r2, s)
                    canon_targets = (ring_theta, side, side)
                    for n in range(3):
                        result.append((i, canon[n], canon[(n + 1) % 3], canon_targets[n]))
                    continue
        if len(neighbors) == 4 and not local_ring:
            ordered = sorted(neighbors, key=lambda j: math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]))
            polar = [math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]) for j in ordered]
            gaps = [(polar[(m + 1) % 4] - polar[m]) % (2 * math.pi) for m in range(4)]
            tetra_idx = _four_connected_tetrahedral_sector(old, i, ordered, gaps, adjacent)
            targets = [0.0] * 4
            targets[tetra_idx] = 2 * math.pi / 3
            targets[(tetra_idx + 1) % 4] = math.pi / 2
            targets[(tetra_idx + 2) % 4] = math.pi / 3
            targets[(tetra_idx + 3) % 4] = math.pi / 2
            for n in range(4):
                result.append((i, ordered[n], ordered[(n + 1) % 4], targets[n]))
            continue
        for n, j in enumerate(neighbors):
            for k in neighbors[n + 1:]:
                key = (i, *sorted((j, k)))
                theta = local_ring.get(key)
                if theta is None:
                    if len(neighbors) == 2 and not mol.GetAtomWithIdx(i).IsInRing():
                        theta = math.pi if mol.GetAtomWithIdx(i).GetHybridization() == Chem.HybridizationType.SP else 2 * math.pi / 3
                    elif len(neighbors) == 3 and not local_ring:
                        theta = 2 * math.pi / 3
                    elif len(neighbors) == 3 and len(local_ring) == 1:
                        theta = (2 * math.pi - next(iter(local_ring.values()))) / 2
                    elif len(neighbors) == 3 and len(local_ring) == 2:
                        rem = 2 * math.pi - sum(local_ring.values())
                        if 0 < rem <= math.pi:
                            theta = rem
                if theta is not None:
                    result.append((i, j, k, theta))
    return result


def _angle(points, i, j, k):
    ax, ay = points[j][0] - points[i][0], points[j][1] - points[i][1]
    bx, by = points[k][0] - points[i][0], points[k][1] - points[i][1]
    return math.atan2(ax * by - ay * bx, ax * bx + ay * by)


def _wrap(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


def _quality(points, edges, angles, length):
    lengths = [abs(math.dist(points[i], points[j]) / length - 1) for i, j in edges]
    angle_errors = [abs(abs(_angle(points, i, j, k)) - theta) for i, j, k, theta in angles]
    overlap = stereo._check_overlaps(points, edges)
    return {"maxBondError": max(lengths, default=0.0),
            "maxAngleError": math.degrees(max(angle_errors, default=0.0)),
            "minNonBonded": None if overlap is None else overlap[0] / length,
            "crossings": _has_crossings(points, edges)}


def _needs_cleanup(quality):
    return (quality["maxBondError"] > _LENGTH_TOLERANCE or
            quality["maxAngleError"] > math.degrees(_ANGLE_TOLERANCE) or
            quality["minNonBonded"] is not None and quality["minNonBonded"] < 0.35 or
            quality["crossings"])


def _signed_angle_targets(old, edges, angles):
    """Resolve antiparallel rays using the neighbours' circular order.

    atan2's sign near 180 degrees depends on signed zero or tiny sketch noise. At a T-shaped
    three-connected centre, independently accepting that sign can contradict
    the other two 120-degree targets. A collinear pair has no established side;
    choose the circular arc containing fewer neighbours instead. Two-connected
    linear chains have equivalent alternatives and retain a deterministic sign.
    This is linear in the angle constraints, without combinatorial branching.
    """
    adjacent = [[] for _ in old]
    for i, j in edges:
        adjacent[i].append(j)
        adjacent[j].append(i)
    positions = []
    for i, neighbors in enumerate(adjacent):
        ordered = sorted(neighbors, key=lambda j: math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]))
        positions.append({j: n for n, j in enumerate(ordered)})
    by_center = {}
    for center, aj, ak, atheta in angles:
        by_center.setdefault(center, []).append((aj, ak, atheta))
    directed_cycles = {
        center
        for center, local in by_center.items()
        if len(adjacent[center]) in (3, 4)
        and len(local) == len(adjacent[center])
        and abs(sum(t for _, _, t in local) - 2 * math.pi) <= 1e-6
        and all(local[m][1] == local[(m + 1) % len(local)][0] for m in range(len(local)))
    }
    result = []
    for i, j, k, theta in angles:
        angle = _angle(old, i, j, k)
        sign = 1 if angle >= 0 else -1
        count = len(adjacent[i])
        if i in directed_cycles:
            sign = 1
        elif abs(abs(angle) - math.pi) <= _ANGLE_TOLERANCE and theta < math.pi - 1e-8:
            steps = (positions[i][k] - positions[i][j]) % count
            if 2 * steps < count:
                sign = 1
            elif 2 * steps > count:
                sign = -1
        result.append((i, j, k, sign * theta))
    return result


def _tetrahedral_anchor_target(old, edges, angles, length):
    adjacent = [[] for _ in old]
    for i, j in edges:
        adjacent[i].append(j)
        adjacent[j].append(i)
    anchor_target = [list(p) for p in old]
    by_center = {}
    for center, j, k, theta in angles:
        by_center.setdefault(center, []).append((j, k, theta))
    for i, neighbors in enumerate(adjacent):
        local_angles = by_center.get(i, ())
        if len(neighbors) in (3, 4) and len(local_angles) == len(neighbors) and abs(sum(t for _, _, t in local_angles) - 2 * math.pi) <= 1e-6:
            if not any(local_angles[m][1] != local_angles[(m + 1) % len(neighbors)][0] for m in range(len(neighbors))):
                r1, r2 = local_angles[0][0], local_angles[0][1]
                if len(adjacent[r1]) > 1 and len(adjacent[r2]) > 1 and _cross(old[i], old[r1], old[r2]) > 0:
                    interior_subs = [
                        s for s in neighbors if s not in (r1, r2)
                        and _cross(old[i], old[r1], old[s]) >= -1e-6 * math.dist(old[i], old[r1]) * math.dist(old[i], old[s])
                        and _cross(old[i], old[s], old[r2]) >= -1e-6 * math.dist(old[i], old[s]) * math.dist(old[i], old[r2])
                    ]
                    if interior_subs and all(len(adjacent[s]) == 1 for s in interior_subs):
                        ang_r1 = math.atan2(old[r1][1] - old[i][1], old[r1][0] - old[i][0])
                        ang_r2 = math.atan2(old[r2][1] - old[i][1], old[r2][0] - old[i][0])
                        ext_bisector = ang_r2 + ((ang_r1 - ang_r2) % (2 * math.pi)) / 2
                        if len(neighbors) == 4:
                            s_first, s_second = local_angles[2][0], local_angles[2][1]
                            target_sub = local_angles[2][2]
                            anchor_target[s_first] = [
                                old[i][0] + length * math.cos(ext_bisector - target_sub / 2),
                                old[i][1] + length * math.sin(ext_bisector - target_sub / 2),
                            ]
                            anchor_target[s_second] = [
                                old[i][0] + length * math.cos(ext_bisector + target_sub / 2),
                                old[i][1] + length * math.sin(ext_bisector + target_sub / 2),
                            ]
                        else:
                            s = local_angles[2][0]
                            anchor_target[s] = [
                                old[i][0] + length * math.cos(ext_bisector),
                                old[i][1] + length * math.sin(ext_bisector),
                            ]
                        continue
        if len(neighbors) != 4 or not all(len(adjacent[u]) == 1 for u in neighbors):
            continue
        pair_120 = next(((j, k) for j, k, theta in local_angles if abs(theta - 2 * math.pi / 3) < 1e-6), None)
        has_60 = any(abs(theta - math.pi / 3) < 1e-6 for _, _, theta in local_angles)
        if pair_120 is None or not has_60:
            continue
        ordered = sorted(neighbors, key=lambda j: math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]))
        polar = [math.atan2(old[j][1] - old[i][1], old[j][0] - old[i][0]) for j in ordered]
        gaps = [(polar[(m + 1) % 4] - polar[m]) % (2 * math.pi) for m in range(4)]
        m = next((idx for idx in range(4) if (ordered[idx], ordered[(idx + 1) % 4]) == pair_120), None)
        if m is None:
            continue
        a, b, c, d = [ordered[(m + idx) % 4] for idx in range(4)]
        va = [old[a][0] - old[i][0], old[a][1] - old[i][1]]
        vb = [old[b][0] - old[i][0], old[b][1] - old[i][1]]
        na, nb = max(math.hypot(*va), 1e-12), max(math.hypot(*vb), 1e-12)
        ux, uy = va[0] / na + vb[0] / nb, va[1] / na + vb[1] / nb
        if abs(gaps[m] - 2 * math.pi / 3) <= math.radians(15) and math.hypot(ux, uy) > 1e-12:
            base = math.atan2(uy, ux)
        else:
            base = -math.pi / 2 if uy <= 0 else math.pi / 2
        ideal = (
            (a, base - math.pi / 3),
            (b, base + math.pi / 3),
            (c, base + 5 * math.pi / 6),
            (d, base - 5 * math.pi / 6),
        )
        for atom_idx, direction in ideal:
            anchor_target[atom_idx] = [old[i][0] + length * math.cos(direction), old[i][1] + length * math.sin(direction)]
    return anchor_target


def _fit_geometry(old, edges, angles, length):
    """Damped least squares, with a small positional term selecting the nearest fit.

    All iterations use the original scale, angle targets and positions.  This is
    one solve, rather than repeatedly treating a partial repair as a new sketch.
    """
    anchor_target = _tetrahedral_anchor_target(old, edges, angles, length)
    origin = np.asarray(_center(old))
    reference = (np.asarray(anchor_target, dtype=float) - origin) / length
    points = reference.copy()
    signed_angles = _signed_angle_targets(old, edges, angles)
    bonded = {tuple(sorted(edge)) for edge in edges}
    nonbonded = [(i, j) for i in range(len(old)) for j in range(i + 1, len(old)) if (i, j) not in bonded]
    size = 2 * len(old)
    anchor = math.sqrt(0.001)

    def system(current):
        residuals, rows = [], []
        for i, j in edges:
            vector = current[i] - current[j]
            distance = float(np.linalg.norm(vector))
            gradient = vector / max(distance, 1e-10)
            row = np.zeros(size)
            row[2 * i:2 * i + 2], row[2 * j:2 * j + 2] = gradient, -gradient
            rows.append(row)
            residuals.append(distance - 1)
        for i, j, k, target in signed_angles:
            a, b = current[j] - current[i], current[k] - current[i]
            aa, bb = float(a @ a), float(b @ b)
            if min(aa, bb) < 1e-12:
                continue
            gj = np.array([a[1], -a[0]]) / aa
            gk = np.array([-b[1], b[0]]) / bb
            row = np.zeros(size)
            row[2 * j:2 * j + 2], row[2 * k:2 * k + 2] = gj, gk
            row[2 * i:2 * i + 2] = -gj - gk
            rows.append(row)
            residuals.append(_wrap(math.atan2(a[0] * b[1] - a[1] * b[0], float(a @ b)) - target))
        for i, j in nonbonded:
            vector = current[i] - current[j]
            distance = float(np.linalg.norm(vector))
            if distance >= 0.6:
                continue
            if distance < 1e-10:
                # Only a starting direction: the final topology/stereo guards
                # decide whether an ambiguous coincident sketch can be applied.
                vector = np.array([math.cos(i + j + 1), math.sin(i + j + 1)])
            gradient = vector / max(float(np.linalg.norm(vector)), 1e-10)
            row = np.zeros(size)
            row[2 * i:2 * i + 2], row[2 * j:2 * j + 2] = gradient, -gradient
            rows.append(row)
            residuals.append(distance - 0.6)
        residuals.extend((anchor * (current - reference)).ravel())
        rows.extend(anchor * np.eye(size))
        return np.asarray(residuals), np.asarray(rows)

    damping = 0.001
    residual, jacobian = system(points)
    cost = float(residual @ residual)
    for _ in range(100):
        try:
            step = np.linalg.solve(jacobian.T @ jacobian + damping * np.eye(size), -jacobian.T @ residual)
        except np.linalg.LinAlgError:
            break
        trial = points + step.reshape((-1, 2))
        trial_residual, trial_jacobian = system(trial)
        trial_cost = float(trial_residual @ trial_residual)
        if trial_cost < cost:
            improvement = cost - trial_cost
            points, residual, jacobian, cost = trial, trial_residual, trial_jacobian, trial_cost
            damping = max(1e-8, damping / 3)
            if max(abs(step), default=0.0) < 1e-9 or improvement < 1e-13:
                break
        else:
            damping *= 10
            if damping > 1e8:
                break
    fitted = (points * length + origin).tolist()
    fitted, _ = stereo._align_to(anchor_target, fitted)
    oc, nc = _center(old), _center(fitted)
    return [[p[k] + oc[k] - nc[k] for k in (0, 1)] for p in fitted]


def _local_cleanup(old, edges, angles=()):
    if not edges:
        return old, {"status": "unchanged", "maxDisplacement": 0.0}
    lengths = [math.dist(old[i], old[j]) for i, j in edges]
    if len(lengths) == 2 and max(lengths) / max(min(lengths), 1e-12) > 1.15 and sum(0.75 <= d <= 1.35 for d in lengths) == 1:
        length = min(lengths, key=lambda d: abs(d - 1.0))
    else:
        length = statistics.median(lengths)
    if length <= 1e-8 or min(lengths) < 1e-6 * length:
        return old, {"status": "retained", "reason": "degenerate_bond", "maxDisplacement": 0.0}
    before = _quality(old, edges, angles, length)
    if not _needs_cleanup(before):
        return old, {"status": "unchanged", "maxDisplacement": 0.0, "quality": before}
    if before["crossings"]:
        return old, {"status": "retained", "reason": "ambiguous_atom_sides", "maxDisplacement": 0.0, "quality": before}
    # Dense small solves are deliberately bounded for pathological imported files.
    if len(old) > 300:
        return old, {"status": "retained", "reason": "component_too_large", "maxDisplacement": 0.0, "quality": before}
    candidate = _fit_geometry(old, edges, angles, length)
    after = _quality(candidate, edges, angles, length)
    maximum = max(math.dist(p, q) for p, q in zip(old, candidate))
    if not _preserves_sides(old, candidate, edges, angles):
        return old, {"status": "retained", "reason": "ambiguous_atom_sides", "maxDisplacement": 0.0, "quality": before}
    if _needs_cleanup(after):
        return old, {"status": "retained", "reason": "incompatible_local_geometry", "maxDisplacement": 0.0, "quality": before}
    return candidate, {"status": "adjusted", "maxDisplacement": maximum, "bondLength": length,
                       "qualityBefore": before, "quality": after}


def layout_section(section):
    atoms = section.get("atoms") or []
    try:
        old = [[float(a["location"][0]), float(a["location"][1])] for a in atoms]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise stereo.StereoError("分子缺少有效二维坐标") from error
    if not old or not all(math.isfinite(v) for p in old for v in p):
        raise stereo.StereoError("分子缺少有效二维坐标")
    mol = stereo.mol_from_section(section)
    edges = [tuple(int(i) for i in b["atoms"]) for b in section.get("bonds") or []]
    angles = _angle_constraints(mol, edges, old)
    new = copy.deepcopy(old)
    reports = []
    for ids in _components(len(old), edges):
        index = {atom: i for i, atom in enumerate(ids)}
        local_edges = [(index[i], index[j]) for i, j in edges if i in index and j in index]
        local_angles = [(index[i], index[j], index[k], theta) for i, j, k, theta in angles if i in index]
        points, report = _local_cleanup([old[i] for i in ids], local_edges, local_angles)
        for i, p in zip(ids, points):
            new[i] = p
        reports.append(report)
    changed = any(math.dist(p, q) > 1e-8 for p, q in zip(old, new))
    if changed:
        candidate = copy.deepcopy(section)
        for atom, xy in zip(candidate["atoms"], new):
            atom["location"] = [*xy, 0.0]
        check = stereo.mol_from_section(candidate)
        before = Chem.MolToSmiles(mol), dict(Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False))
        after = Chem.MolToSmiles(check), dict(Chem.FindMolChiralCenters(check, includeUnassigned=True, useLegacyImplementation=False))
        if before != after:
            new, changed = old, False
            reports.append({"status": "retained", "reason": "stereochemistry_guard", "maxDisplacement": 0.0})
    return {"atoms": new,
            "bonds": [{"i": i, "j": j, "stereo": int(b.get("stereo") or 0), "order": [i, j]}
                      for b, (i, j) in zip(section.get("bonds") or [], edges)],
            "coordinateScale": "preserved",
            "report": {"mode": "preserve", "changed": changed, "components": reports,
                       "maxDisplacement": max(math.dist(p, q) for p, q in zip(old, new))}}


def layout_ket(ket_text, targets=None, points=None):
    try:
        doc = json.loads(ket_text)
    except Exception as error:
        raise stereo.StereoError(f"KET 解析失败：{error}") from error
    keys = stereo.molecule_keys(doc)
    if targets is None:
        targets = stereo._targets_by_points(doc, keys, points) if points else list(keys)
    targets = [key for key in targets if key in keys]
    if not targets:
        raise stereo.StereoError("没有可整理的分子")
    results, skipped, warnings = [], [], []
    reasons = {"degenerate_bond": "存在重合的成键原子，无法确定原有方向",
               "ambiguous_atom_sides": "局部整理会交换原有取代基方向，已保留原有画法",
               "incompatible_local_geometry": "局部几何约束冲突，已保留原有画法",
               "component_too_large": "结构过大，已保留原有画法",
               "stereochemistry_guard": "局部整理会改变立体构型，已保留原有画法"}
    for key in targets:
        try:
            result = layout_section(doc[key])
        except stereo.StereoError as error:
            skipped.append({"key": key, "error": str(error)})
            continue
        result["key"] = key
        results.append(result)
        retained = [component for component in result["report"]["components"] if component["status"] == "retained"]
        for component in retained:
            reason = component.get("reason", "incompatible_local_geometry")
            warnings.append({"key": key, "code": reason, "message": reasons.get(reason, "无法安全整理，已保留原有画法")})
    if not results:
        raise stereo.StereoError(f"{skipped[0]['key']}: {skipped[0]['error']}")
    return {"ok": True, "molecules": results, "targets": targets, "allKeys": keys,
            "coordinateScale": "preserved", "mode": "preserve", "warnings": warnings,
            **({"skipped": skipped} if skipped else {})}
