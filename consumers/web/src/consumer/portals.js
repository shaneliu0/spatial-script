// Portal rendering (SPEC 3.11).
// A portal is a plane mesh and a window, not a mirror. Its world group is hidden
// from the main render and drawn into a render target from the viewer's own
// camera; the portal surface then samples that target at each fragment's own
// screen position, so the world is seen from where the viewer is standing and
// can never appear outside the portal rectangle. See `updateCamera` below.

import * as THREE from 'three';

const PORTAL_VERTEX = `
uniform mat4 uTextureMatrix;
varying vec4 vProjected;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vProjected = uTextureMatrix * world;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const PORTAL_FRAGMENT = `
uniform sampler2D uMap;
varying vec4 vProjected;
void main() {
  vec2 uv = vProjected.xy / max(0.0001, vProjected.w);
  gl_FragColor = texture2D(uMap, uv);
  #include <colorspace_fragment>
}`;

export class Portal {
  /**
   * @param {THREE.Mesh} mesh the portal surface in the scene graph
   * @param {{worldId:number,width:number,height:number,crossing:boolean}} spec
   */
  constructor(mesh, spec, size = 1024) {
    this.mesh = mesh;
    this.spec = spec;
    this.target = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.target.texture },
        uTextureMatrix: { value: this.textureMatrix },
      },
      vertexShader: PORTAL_VERTEX,
      fragmentShader: PORTAL_FRAGMENT,
      side: THREE.DoubleSide,
    });
    mesh.geometry = new THREE.PlaneGeometry(spec.width ?? 0.5, spec.height ?? 0.5);
    mesh.material = this.material;
  }

  resize(spec) {
    this.spec = spec;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(spec.width ?? 0.5, spec.height ?? 0.5);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }

  /** Matches the render target to the drawing buffer so the window is not stretched. */
  resizeTarget(width, height) {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
  }

  /**
   * A portal is a window, not a mirror. The world is rendered from the viewer's
   * own camera and each portal fragment samples the target at its own screen
   * position, so world content can only ever appear where the portal surface is
   * drawn: nothing can bleed outside the rectangle, and the world is seen from
   * the angle the viewer is actually standing at, as RealityKit's
   * PortalComponent shows it.
   *
   * A mirrored camera was the earlier approach; it reflected the world, so a
   * ground plane came out edge-on and the framing disagreed with RealityKit.
   */
  updateCamera(camera) {
    this.camera.copy(camera);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // Clip space to 0..1 texture coordinates.
    this.textureMatrix.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    this.textureMatrix.multiply(this.camera.projectionMatrix);
    this.textureMatrix.multiply(this.camera.matrixWorldInverse);
  }
}
