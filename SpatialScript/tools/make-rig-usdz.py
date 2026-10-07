#!/usr/bin/env python3
"""Authors assets/rig.usdz, the RealityKit twin of assets/rig.glb.

RealityKit cannot read glTF, so the shared asset root needs a USD copy of the
same rig for `loadAsset({ usdz: "asset://rig.usdz", glb: "asset://rig.glb" })`
to resolve on both backends. The two must describe the same thing:

  * a 0.1 x 0.4 x 0.1 box split into three bands in Y, 40 points, 28 triangles;
  * a two joint skeleton, `root` at the origin and `head` 0.2 m above it, with
    every point above the waist bound to `head` and every point below it to
    `root`, so rotating `head` visibly bends the top half;
  * one blend shape, `widen`, that pushes each point 0.075 m further out along
    its own side in X;
  * a blue UsdPreviewSurface.

Requires Pixar's USD Python package:

    python3 -m pip install --user usd-core
    python3 SpatialScript/tools/make-rig-usdz.py

The package is written with `UsdUtils.CreateNewUsdzPackage`, which is what the
`usdzip` tool calls; the wheel does not ship the executable.
"""

import os
import sys

try:
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdSkel, UsdUtils, Vt
except ImportError:  # pragma: no cover - the message is the point
    sys.exit(
        "This script needs Pixar's USD Python package:\n"
        "    python3 -m pip install --user usd-core"
    )

HALF_X = 0.05
HALF_Z = 0.05
TOP = 0.2
BANDS = [0.2, 0.0667, -0.0667, -0.2]
WIDEN = 0.075

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
STAGE_PATH = os.path.join(ASSETS, "rig.usda")
PACKAGE_PATH = os.path.join(ASSETS, "rig.usdz")


def box_geometry():
    """The same 40 point, 28 triangle box the glTF rig carries.

    Every face keeps its own points so the normals stay hard, which is why a
    corner appears more than once.
    """
    points = []
    normals = []
    uvs = []
    indices = []

    def quad_strip(corner, normal):
        """A vertical strip of quads down one side, banded in Y."""
        base = len(points)
        for y in BANDS:
            for x, z in corner:
                points.append(Gf.Vec3f(x, y, z))
                normals.append(Gf.Vec3f(*normal))
                uvs.append(Gf.Vec2f((x + HALF_X) / (2 * HALF_X), (y + TOP) / (2 * TOP)))
        for band in range(len(BANDS) - 1):
            a = base + band * 2
            indices.extend([a, a + 2, a + 1, a + 2, a + 3, a + 1])

    def quad(corner, normal):
        base = len(points)
        for x, y, z in corner:
            points.append(Gf.Vec3f(x, y, z))
            normals.append(Gf.Vec3f(*normal))
            uvs.append(Gf.Vec2f((x + HALF_X) / (2 * HALF_X), (z + HALF_Z) / (2 * HALF_Z)))
        indices.extend([base, base + 2, base + 1, base + 2, base + 3, base + 1])

    # +X and -X sides are banded so the skin can bend across the waist.
    quad_strip([(HALF_X, HALF_Z), (HALF_X, -HALF_Z)], (1, 0, 0))
    quad_strip([(-HALF_X, -HALF_Z), (-HALF_X, HALF_Z)], (-1, 0, 0))
    # Top and bottom caps.
    quad(
        [(-HALF_X, TOP, -HALF_Z), (HALF_X, TOP, -HALF_Z), (-HALF_X, TOP, HALF_Z), (HALF_X, TOP, HALF_Z)],
        (0, 1, 0),
    )
    quad(
        [
            (-HALF_X, -TOP, HALF_Z),
            (HALF_X, -TOP, HALF_Z),
            (-HALF_X, -TOP, -HALF_Z),
            (HALF_X, -TOP, -HALF_Z),
        ],
        (0, -1, 0),
    )
    # +Z and -Z faces, banded to match the sides.
    for sign, normal in ((HALF_Z, (0, 0, 1)), (-HALF_Z, (0, 0, -1))):
        base = len(points)
        order = [(-HALF_X, sign), (HALF_X, sign)] if sign > 0 else [(HALF_X, sign), (-HALF_X, sign)]
        for y in BANDS:
            for x, z in order:
                points.append(Gf.Vec3f(x, y, z))
                normals.append(Gf.Vec3f(*normal))
                uvs.append(Gf.Vec2f((x + HALF_X) / (2 * HALF_X), (y + TOP) / (2 * TOP)))
        for band in range(len(BANDS) - 1):
            a = base + band * 2
            indices.extend([a, a + 2, a + 1, a + 2, a + 3, a + 1])

    return points, normals, uvs, indices


def main():
    points, normals, uvs, indices = box_geometry()
    counts = [3] * (len(indices) // 3)

    # Above the waist follows `head`, below it follows `root`.
    joint_indices = [1 if point[1] > 0 else 0 for point in points]
    joint_weights = [1.0] * len(points)
    # `widen` pushes every point further out along the side it is already on.
    offsets = [Gf.Vec3f(WIDEN if point[0] > 0 else -WIDEN, 0.0, 0.0) for point in points]

    stage = Usd.Stage.CreateNew(STAGE_PATH)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    root = UsdSkel.Root.Define(stage, "/rig")
    stage.SetDefaultPrim(root.GetPrim())

    skeleton = UsdSkel.Skeleton.Define(stage, "/rig/skeleton")
    skeleton.CreateJointsAttr(Vt.TokenArray(["root", "root/head"]))
    # RealityKit reports whatever is in `jointNames`, so the leaf names the
    # script addresses are spelled out rather than left to the path.
    skeleton.CreateJointNamesAttr(Vt.TokenArray(["root", "head"]))
    identity = Gf.Matrix4d(1)
    head_world = Gf.Matrix4d(1).SetTranslate(Gf.Vec3d(0, 0.2, 0))
    skeleton.CreateBindTransformsAttr(Vt.Matrix4dArray([identity, head_world]))
    skeleton.CreateRestTransformsAttr(Vt.Matrix4dArray([identity, head_world]))

    mesh = UsdGeom.Mesh.Define(stage, "/rig/body")
    mesh.CreatePointsAttr(Vt.Vec3fArray(points))
    mesh.CreateNormalsAttr(Vt.Vec3fArray(normals))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateExtentAttr(
        Vt.Vec3fArray([Gf.Vec3f(-HALF_X, -TOP, -HALF_Z), Gf.Vec3f(HALF_X, TOP, HALF_Z)])
    )
    texcoords = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar(
        "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex
    )
    texcoords.Set(Vt.Vec2fArray(uvs))

    binding = UsdSkel.BindingAPI.Apply(mesh.GetPrim())
    binding.CreateSkeletonRel().SetTargets([skeleton.GetPath()])
    binding.CreateGeomBindTransformAttr(identity)
    binding.CreateJointIndicesPrimvar(constant=False, elementSize=1).Set(
        Vt.IntArray(joint_indices)
    )
    binding.CreateJointWeightsPrimvar(constant=False, elementSize=1).Set(
        Vt.FloatArray(joint_weights)
    )

    blend_shape = UsdSkel.BlendShape.Define(stage, "/rig/body/widen")
    blend_shape.CreateOffsetsAttr(Vt.Vec3fArray(offsets))
    blend_shape.CreatePointIndicesAttr(Vt.IntArray(list(range(len(points)))))
    binding.CreateBlendShapesAttr(Vt.TokenArray(["widen"]))
    binding.CreateBlendShapeTargetsRel().SetTargets([blend_shape.GetPath()])

    # An animation source keeps the rig at its rest pose, which is what makes
    # the skeleton resolve to a real pose rather than an empty one.
    animation = UsdSkel.Animation.Define(stage, "/rig/skeleton/rest")
    animation.CreateJointsAttr(Vt.TokenArray(["root", "root/head"]))
    animation.CreateTranslationsAttr(
        Vt.Vec3fArray([Gf.Vec3f(0, 0, 0), Gf.Vec3f(0, 0.2, 0)])
    )
    animation.CreateRotationsAttr(
        Vt.QuatfArray([Gf.Quatf(1, 0, 0, 0), Gf.Quatf(1, 0, 0, 0)])
    )
    animation.CreateScalesAttr(Vt.Vec3hArray([Gf.Vec3h(1, 1, 1), Gf.Vec3h(1, 1, 1)]))
    animation.CreateBlendShapesAttr(Vt.TokenArray(["widen"]))
    animation.CreateBlendShapeWeightsAttr(Vt.FloatArray([0.0]))
    UsdSkel.BindingAPI.Apply(skeleton.GetPrim()).CreateAnimationSourceRel().SetTargets(
        [animation.GetPath()]
    )

    material = UsdShade.Material.Define(stage, "/rig/materials/body")
    shader = UsdShade.Shader.Define(stage, "/rig/materials/body/surface")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(
        Gf.Vec3f(0.1329, 0.6038, 1.0)
    )
    shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(1.0)
    material.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)

    stage.GetRootLayer().Save()

    if os.path.exists(PACKAGE_PATH):
        os.remove(PACKAGE_PATH)
    if not UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(STAGE_PATH), PACKAGE_PATH):
        sys.exit("usdz packaging failed")
    os.remove(STAGE_PATH)
    print("wrote", PACKAGE_PATH, os.path.getsize(PACKAGE_PATH), "bytes")


if __name__ == "__main__":
    main()
