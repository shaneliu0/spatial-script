const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const ball = new S.Mesh(new S.SphereGeometry(0.1), new S.MeshStandardMaterial({ color: 0xffaa33 }));
ball.name = "ball";
ball.rigidBody = new S.RigidBody({ type: "dynamic", mass: 1 });
scene.add(ball);

const fx = new S.ParticleEmitter({ rate: 10 });
fx.name = "fx";
scene.add(fx);

// SPEC 5 ordering: none of these can name an id the consumer has not seen, so
// they wait for the frame after the object's `create` instead of being dropped.
ball.rigidBody.applyImpulse(new S.Vector3(0, 1, 0));
ball.rigidBody.setLinearVelocity(new S.Vector3(0, 2, 0));
fx.burst();

// An object that never joins the scene is still a mistake, and still drops.
const loose = new S.ParticleEmitter({});
loose.name = "loose";
loose.burst();

S.mount(scene);

// The dump is the only runner-independent view of what the core decided, so
// the script reads its own warnings rather than the command stream.
//
// The velocity itself is deliberately not asserted: a real consumer integrates
// gravity between applying the deferred command and this read, so the exact
// number differs per backend. What every backend must agree on is that the
// velocity was applied at all rather than dropped.
S.onFrame(() => {
  const warnings = S.dump({ objects: false }).warnings;
  scene.userData.frame = S.time.frame;
  // Three calls were made before any flush, and all three must have waited
  // rather than been dropped; only `loose` may appear in `dropped`.
  scene.userData.deferredCalls = 3;
  scene.userData.dropped = warnings.filter((warning) => /was dropped/.test(warning));
  scene.userData.velocityApplied = ball.rigidBody.linearVelocity.y > 1.5;
});
