//
//  ScriptingCommandApplier.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Combine
import Foundation
import JavaScriptCore
import RealityKit

/// Mirrors the command stream defined in SPEC section 5 onto RealityKit
/// entities. One applier belongs to one ``JavaScriptScene``.
@MainActor
final class ScriptingCommandApplier {
    enum Kind: String {
        case group
        case mesh
        case ambientLight
        case directionalLight
        case pointLight
        case spotLight
        case particles
        case anchor
        case portal
        case asset
    }

    /// Everything the consumer tracks for one scripted object.
    final class Record {
        let id: Int
        var kind: Kind
        let entity: Entity
        var lightHolder: Entity?
        var materialSpec: ScriptingMaterialSpec?
        var nativeMaterial: (any RealityKit.Material)?
        /// SPEC 14.12: set when the mesh carries a material per part.
        var materialSpecs: [ScriptingMaterialSpec]?
        /// How many material slots the model actually draws, which is what the
        /// dump reports: extras beyond the group count are not drawn and a
        /// short array repeats its last entry.
        var drawnMaterialCount: Int?
        /// SPEC 14.12: how many `geometry.groups` the descriptor carried, and
        /// how many of them actually split the mesh.
        var geometryGroups: Int?
        var geometryRawGroupCount: Int?
        var mesh: MeshResource?
        /// The cache keys this record's resources are stored under, so the
        /// cache knows an entry is still drawn and never evicts it (SPEC 5: a
        /// delivered geometry may be re-sent with no buffers at all).
        var meshCacheKey: String?
        var materialCacheKeys: [ScriptingMaterialKey] = []
        var shapeCacheKey: String?
        var geometryType = ""
        var geometryParameters: [String: Any] = [:]
        var geometryKey: String?
        /// The geometry instance this record drew, so the cache entry can go
        /// when the last user of that instance does.
        var geometryUUID: String?
        var bodyType: String?
        var bodyShape = "auto"
        /// True once the async static triangle mesh shape is actually on the
        /// entity, so the dump reports the shape that exists.
        var hasStaticMeshShape = false
        var isTrigger = false
        /// SPEC 8: all five flags the core's `interactive` command carries.
        var interactive = (
            tap: false, hover: false, drag: false, manipulation: false, collision: false
        )
        var isManipulated = false
        var isAnchoredState = false
        var assetContainer: Entity?
        /// The url the asset was loaded from, for SPEC 8's `asset` field.
        var assetSource: String?
        /// SPEC 8: the core dumps the url set the script gave (`{ ...urls }`),
        /// so the mirror reports the same shape rather than the one url this
        /// backend picked out of it.
        var assetURLs: [String: Any] = [:]
        var animation: AnimationPlaybackController?
        var pendingLightDirection: SIMD3<Float>?
        var lightSpec: [String: Any] = [:]
        var bodySpec: [String: Any] = [:]
        var anchorSpec: [String: Any] = [:]
        var portalSpec: [String: Any] = [:]
        /// SPEC 8: the flag the script set. A mesh carries it as a
        /// `DynamicLightShadowComponent` and a light as its own shadow
        /// component, so the dump reports what was applied rather than one of
        /// the two mechanisms.
        var castShadow = false
        /// three.js defaults `receiveShadow` to false and the core only sends
        /// the flag when a script changes it, so the mirror starts where the
        /// core starts. RealityKit surfaces receive shadows regardless; the
        /// dump reports the applied flag, not the engine's behaviour.
        var receiveShadow = false
        var hoverEffect: String?
        var manipulable = false
        var renderOrder = 0
        var isAmbientSource = false
        var needsCollisionShape = false
        var particlesLoop = true
        var particleLifetime: Double = 0
        /// SPEC 8: the emitter configuration the consumer applied. RealityKit's
        /// preset components do not read back the numbers they were built from,
        /// so the dump reports the payload it was given, with the live emitter
        /// state on top.
        var particleSpec: [String: Any] = [:]
        var particlesElapsed: Double = 0
        var previousWorldPosition: SIMD3<Float>?
        var previousWorldOrientation: simd_quatf?
        var linearVelocity: SIMD3<Float> = .zero
        var angularVelocity: SIMD3<Float> = .zero
        var restingFrames = 0
        /// True once the simulation has actually moved this body, which is
        /// when the measured velocity becomes worth reporting.
        var hasObservedMotion = false
        var isSleeping: Bool { restingFrames >= ScriptingMotionSampling.sleepFrameThreshold }
        /// Phase 2 state, allocated only for the objects that use it.
        var extras: ScriptingRecordExtras?

        @MainActor
        func makeExtras() -> ScriptingRecordExtras {
            if let extras { return extras }
            let created = ScriptingRecordExtras()
            extras = created
            return created
        }

        init(id: Int, kind: Kind, entity: Entity) {
            self.id = id
            self.kind = kind
            self.entity = entity
        }
    }

    static let transformStrategy = ScriptingTransformStrategy.current
    static let colliderStrategy = ScriptingColliderStrategy.current

    static let hitTestGroup = CollisionGroup(rawValue: 1 << 0)
    static let physicsGroup = CollisionGroup(rawValue: 1 << 1)

    let root: Entity
    let warnings = ScriptingWarningCollector()
    let resources = ScriptingResourceCache()
    private(set) var records: [Int: Record] = [:]
    private(set) var textures: ScriptingTextureStore
    var worldGroups: Set<Int> = []
    private var cachedDefaultMaterial: (any RealityKit.Material)?
    var textureIDsByURL: [String: Int] = [:]
    /// texture id → records whose material references it.
    private var materialsByTexture: [Int: Set<Int>] = [:]
    var assetIDsByURL: [String: Int] = [:]
    var jointSpecs: [Int: ScriptingJointSpec] = [:]
    private var environmentEntity: Entity?
    var ambientLight: (resource: EnvironmentResource, intensity: Float)?
    var explicitEnvironment: (resource: EnvironmentResource, intensity: Float)?
    /// The url behind the active environment, for SPEC 8's `environment`.
    var environmentURL: String?
    /// The intensity the script asked for, kept whether or not the resource
    /// resolves, so the dump reports the request and not only the result.
    var environmentIntensity: Float = 1
    private var subscriptions: [any Cancellable] = []
    private var didSubscribe = false
    // MARK: - Loads in flight (SPEC 14.13a)

    /// Every resource load this consumer has started and not yet answered,
    /// by a token, with the url it is waiting on. A parity plan will not grant
    /// the next frame while any of these is outstanding, so a script that
    /// starts a load on frame 30 gets its result on frame 31 on every backend
    /// rather than whenever the file system happens to answer.
    private var loadsInFlight: [Int: String] = [:]
    private var nextLoadToken = 0

    /// Loads this consumer is waiting on, including the texture store's.
    var pendingLoads: Int { loadsInFlight.count + textures.pendingLoads }
    /// The urls those loads are waiting on, for a plan error that has to name
    /// what it gave up on.
    var pendingLoadURLs: [String] {
        (loadsInFlight.values.sorted() + textures.pendingLoadURLs).sorted()
    }

    /// Returns the token to hand back to `endLoad` on success *or* failure.
    func beginLoad(_ url: String) -> Int {
        nextLoadToken += 1
        loadsInFlight[nextLoadToken] = url
        return nextLoadToken
    }

    func endLoad(_ token: Int) {
        loadsInFlight[token] = nil
    }

    /// Bumped by dispose. A deferred load that finishes afterwards is dropped.
    /// SPEC 8: the same counter the core reports. The core numbers the first
    /// script it loads generation 1 (`runtime.loadGeneration + 1` on load), so
    /// the mirror starts there too and a hot reload takes both to 2.
    private(set) var loadGeneration = 1
    private(set) var isDisposed = false
    private var activeCollisions: Set<CollisionPair> = []
    private var lastContacts: [CollisionPair: (point: SIMD3<Float>, normal: SIMD3<Float>)] = [:]

    /// An unordered pair of scripted ids. RealityKit delivers `Began` for both
    /// orderings of a pair, and the core mirrors each event onto the other
    /// object, so without this the listeners fire twice.
    struct CollisionPair: Hashable {
        let low: Int
        let high: Int

        init(_ a: Int, _ b: Int) {
            low = min(a, b)
            high = max(a, b)
        }
    }

    // MARK: - Phase 2 state (SPEC section 14)

    /// SPEC 14.1 mixer. Group gain is master times group; the object's own
    /// volume stays on its audio component.
    var audioMasterVolume: Double = 1
    var audioGroupVolumes: [String: Double] = [:]
    var didWarnAudioCone = false
    /// SPEC 14.13: `audioState` is reported once, when a sound actually starts.
    var didReportAudioRunning = false
    /// Set by the host when a harness drives the media sync channel: the
    /// consumer then stops sampling its own players, which would overwrite the
    /// state that was pushed in.
    var mediaSyncIsExternal = false
    /// SPEC 14.3. The active camera as the core last described it.
    var cameraSpec: [String: Any]?
    /// Entity carrying the camera component, parented under the root.
    var cameraEntity: Entity?
    /// The scripted object the camera command described, when one matched.
    var cameraRecordID: Int?
    /// SPEC 14.7.
    var sceneUnderstandingSpec: [String: Any] = [:]
    /// SPEC 14.11.
    var renderOptions: [String: Any] = [:]
    /// SPEC 14.11 `environmentLighting.intensityExponent`. macOS has no
    /// passthrough to blend with, so the exponent is added to the image based
    /// light's own exponent instead.
    /// SPEC 8: the core's default is 1, so an untouched scene reports 1.
    var environmentIntensityExponent: Float = 1

    /// A grouped geometry from this command batch, kept only long enough for a
    /// `material` array in the same batch to ask for the split mesh.
    struct GroupedGeometry {
        var key: String?
        var groups: [ScriptingGeometryFactory.Group]
        var buffers: ScriptingGeometryFactory.Buffers
    }

    var pendingGroupedGeometry: [Int: GroupedGeometry] = [:]

    /// Set by ``JavaScriptScene`` so events reach the core.
    var dispatch: ((String, Int, [String: Any]?) -> Void)?
    /// SPEC 14.10 script-to-host channel.
    var hostEvent: ((String, [String: Any]?) -> Void)?
    var hostCall: ((Int, String, [String: Any]?) -> Void)?
    var hostFetch: ((Int, [String: Any]?) -> Void)?
    var emitLog: ((ScriptingLogLevel, String) -> Void)?
    var emitWarning: ((String, String) -> Void)?
    /// `Object.keys` captured by the host before the script ran.
    var ownKeysFunction: JSObjectRef?
    /// Set per batch by the host; see `JavaScriptScene.prototypeIsClean()`.
    var prototypeIsClean = true
    private var checkedPayloadShapes: Set<Int> = []

    /// Where this consumer looks for asset bytes. It is not the same thing as
    /// the core's `environment.assetRoot`: that is the text scripts resolve
    /// their urls against and it appears in both dumps, while this is a real
    /// directory on disk. They are the same in the app; the conformance runner
    /// keeps the core's root as the literal string "assets" so its url text
    /// matches the node runner, and points this at the real folder.
    let assetDirectory: URL?

    init(root: Entity, assetDirectory: URL?) {
        self.root = root
        self.assetDirectory = assetDirectory
        textures = ScriptingTextureStore(assetDirectory: assetDirectory)
        warnings.onWarning = { [weak self] key, message in
            self?.emitWarning?(key, message)
        }
        textures.onLoaded = { [weak self] id in
            guard let self else { return }
            // Texture presence is part of the material key, so a finished load
            // mints new keys on its own: no cache flush, and only the records
            // that actually reference the texture are touched.
            reapplyMaterials(referencing: id)
            dispatch?("textureLoaded", id, nil)
        }
        textures.onSettingsChanged = { [weak self] id in
            // The sampler settings are part of the material cache key, so a new
            // key is minted for the new settings and the whole cache survives.
            self?.reapplyMaterials(referencing: id)
        }
        textures.onFailed = { [weak self] id, message in
            guard let self else { return }
            // SPEC 3.5: the core writes the one backend-neutral warning for a
            // load failure. The platform's own message still travels in the
            // event payload, and from there into `texture.error`.
            dispatch?("textureError", id, ["message": message])
        }
    }

    /// SPEC 12 forbids silent no-ops, and an unknown key inside a payload is
    /// exactly how a phase-2 field ships half implemented.
    func warnUnknownKeys(_ payload: [String: Any], expected: Set<String>, opcode: String) {
        // The warning is once per key per opcode, and a scene sends thousands
        // of identically shaped payloads, so only the shapes that have not been
        // seen before are inspected.
        var shape = Hasher()
        shape.combine(opcode)
        shape.combine(payload.count)
        for key in payload.keys.sorted() { shape.combine(key) }
        guard checkedPayloadShapes.insert(shape.finalize()).inserted else { return }
        for key in payload.keys where !expected.contains(key) {
            warnings.warnOnce(
                "The \(opcode) payload carried an unrecognised key '\(key)', which was ignored",
                key: "unknown-key-\(opcode)-\(key)"
            )
        }
    }

    static let materialKeys: Set<String> = [
        "type", "uuid", "color", "opacity", "transparent", "side", "wireframe", "metalness",
        "roughness", "emissive", "emissiveIntensity", "clearcoat", "clearcoatRoughness",
        "depthWrite", "depthTest", "blending", "maps",
    ]
    /// SPEC 5's rigid body payload. A trigger's type is normalised to "static"
    /// by the core, which keeps the type the script authored in
    /// `requestedType` beside `requestedShape`; both are descriptive and
    /// neither is a key this consumer should warn about.
    static let bodyKeys: Set<String> = [
        "type", "mass", "shape", "requestedShape", "requestedType", "friction", "restitution",
        "linearDamping", "angularDamping", "isTrigger", "gravity",
    ]
    static let lightKeys: Set<String> = [
        "type", "color", "intensity", "distance", "decay", "angle", "penumbra",
        "castShadow", "direction",
    ]
    static let particleKeys: Set<String> = [
        "preset", "shape", "shapeSize", "birthRate", "lifetime", "lifetimeVariation",
        "speed", "speedVariation", "size", "sizeVariation", "color", "colorEnd",
        "opacity", "opacityEnd", "spreadAngle", "acceleration", "isEmitting",
        "burstCount", "loops", "texture",
    ]
    static let anchorKeys: Set<String> = [
        "kind", "named", "plane", "minimumBounds", "hand", "location", "image", "world", "matrix",
    ]

    func textureID(forURL url: String) -> Int? { textureIDsByURL[url] }

    func assetID(forURL url: String) -> Int? { assetIDsByURL[url] }

    func entity(for id: Int) -> Entity? {
        id == 0 ? root : records[id]?.entity
    }

    func record(forEntity entity: Entity) -> Record? {
        guard let component = entity.components[ScriptingEntityComponent.self] else { return nil }
        return records[component.entityID]
    }

    // MARK: - Command application

    @discardableResult
    func apply(commands value: JSValue, in context: JSContext) -> Int {
        guard let contextRef = context.jsGlobalContextRef,
              let list = JavaScriptArrayReader(context: contextRef, value: value.jsValueRef) else { return 0 }
        let ownKeys = ownKeysFunction
        let clean = prototypeIsClean
        let count = list.count
        for index in 0..<count {
            guard let raw = list.raw(index),
                  var command = JavaScriptArrayReader(
                      context: contextRef,
                      value: raw,
                      ownKeys: ownKeys
                  ) else {
                warnings.warnOnce(
                    "Command at index \(index) is not an array and was ignored",
                    key: "malformed-command"
                )
                continue
            }
            command.prototypeIsClean = clean
            guard command.count >= 1, let opcode = command.string(0) else {
                warnings.warnOnce(
                    "Command at index \(index) has no opcode and was ignored",
                    key: "malformed-opcode"
                )
                continue
            }
            apply(command: command, opcode: opcode, in: context)
        }
        flushPendingLightDirections()
        subscribeToSceneEventsIfNeeded()
        // The buffers a split would need are kept only for the batch that
        // carried them, so a mesh that never gets a material array never pays.
        pendingGroupedGeometry.removeAll(keepingCapacity: true)
        return count
    }

    private func apply(command: JavaScriptArrayReader, opcode: String, in context: JSContext) {
        let id = command.int(1)

        switch opcode {
        case "create":
            let rawKind = command.string(2) ?? "group"
            guard let kind = Kind(rawValue: rawKind) else {
                warnings.warnOnce(
                    "create kind '\(rawKind)' is not known; the object was made a plain group",
                    key: "create-kind-\(rawKind)"
                )
                createEntity(id: id, kind: .group, name: command.string(3) ?? "")
                return
            }
            createEntity(id: id, kind: kind, name: command.string(3) ?? "")

        case "destroy":
            destroyEntity(id: id)

        case "parent":
            setParent(id: id, parentID: command.int(2))

        case "name":
            records[id]?.entity.name = command.string(2) ?? ""

        case "transform":
            applyTransform(id: id, command: command)

        case "transforms":
            applyTransforms(command: command)

        case "visible":
            records[id]?.entity.isEnabled = command.bool(2)

        case "geometry":
            applyGeometry(id: id, command: command, context: context)

        case "material":
            // SPEC 14.12: an array payload is one material per mesh part.
            if command.isArray(2) {
                guard let payloads = command.dictionaries(2, in: context) else { return }
                applyMaterialArray(id: id, payloads: payloads)
                return
            }
            guard let payload = command.dictionary(2, in: context) else { return }
            // SPEC 14.6 materials are loaded from a USD file, not built here.
            if payload["type"] as? String == "ShaderGraphMaterial" {
                applyShaderGraphMaterial(id: id, payload: payload)
                return
            }
            warnUnknownKeys(payload, expected: Self.materialKeys, opcode: "material")
            let spec = ScriptingMaterialSpec(payload: payload)
            records[id]?.materialSpecs = nil
            records[id]?.drawnMaterialCount = nil
            indexMaterial(spec, for: id)
            applyMaterial(id: id, spec: spec)

        case "texture":
            guard let payload = command.dictionary(2, in: context) else {
                // SPEC 5: a null payload releases the texture.
                textures.release(id: id)
                textureIDsByURL = textureIDsByURL.filter { $0.value != id }
                reapplyMaterials(referencing: id)
                materialsByTexture[id] = nil
                return
            }
            if let url = payload["url"] as? String { textureIDsByURL[url] = id }
            textures.declare(id: id, payload: payload)

        case "light":
            guard let payload = command.dictionary(2, in: context) else { return }
            warnUnknownKeys(payload, expected: Self.lightKeys, opcode: "light")
            applyLight(id: id, payload: payload)

        case "shadow":
            applyShadow(id: id, casts: command.bool(2), receives: command.bool(3))

        case "opacity":
            applyOpacity(id: id, value: command.float(2))

        case "billboard":
            applyBillboard(id: id, enabled: command.bool(2))

        case "groundingShadow":
            applyGroundingShadow(id: id, enabled: command.bool(2))

        case "hoverEffect":
            applyHoverEffect(id: id, style: command.string(2))

        case "manipulable":
            applyManipulable(id: id, enabled: command.bool(2))

        case "renderOrder":
            applyRenderOrder(id: id, order: command.int(2))

        case "interactive":
            guard let payload = command.dictionary(2, in: context) else { return }
            applyInteractive(id: id, payload: payload)

        case "rigidBody":
            let body = command.dictionary(2, in: context)
            if let body { warnUnknownKeys(body, expected: Self.bodyKeys, opcode: "rigidBody") }
            applyRigidBody(id: id, payload: body)

        case "bodyImpulse":
            applyImpulse(id: id, command: command)

        case "bodyForce":
            applyForce(id: id, command: command)

        case "bodyTorque":
            applyTorque(id: id, command: command)

        case "bodyVelocity":
            applyVelocity(id: id, command: command)

        case "joint":
            applyJoint(id: id, payload: command.dictionary(2, in: context))

        case "gravity":
            applyGravity(SIMD3(command.float(2), command.float(3), command.float(4)))

        case "particles":
            guard let payload = command.dictionary(2, in: context) else { return }
            warnUnknownKeys(payload, expected: Self.particleKeys, opcode: "particles")
            applyParticles(id: id, payload: payload)

        case "particlesBurst":
            burstParticles(id: id)

        case "anchor":
            let anchor = command.dictionary(2, in: context)
            if let anchor { warnUnknownKeys(anchor, expected: Self.anchorKeys, opcode: "anchor") }
            applyAnchor(id: id, payload: anchor, name: command.string(2))

        case "portal":
            guard let payload = command.dictionary(2, in: context) else { return }
            applyPortal(id: id, payload: payload)

        case "world":
            applyWorld(id: id, enabled: command.bool(2))

        case "asset":
            guard let payload = command.dictionary(2, in: context) else { return }
            loadAsset(id: id, payload: payload)

        case "assetAnimation":
            playAssetAnimation(
                id: id,
                name: command.string(2),
                loop: command.bool(3),
                speed: command.float(4)
            )

        case "environment":
            applyEnvironment(payload: command.dictionary(2, in: context))

        case "log":
            let level = ScriptingLogLevel(rawValue: command.string(2) ?? "log") ?? .log
            emitLog?(level, command.string(3) ?? "")

        default:
            // SPEC section 14's opcodes live in their own files so this switch
            // stays the phase 1 protocol.
            if applyPhase2(command: command, opcode: opcode, id: id, in: context) { return }
            warnings.warnOnce("Unknown command '\(opcode)' was ignored.", key: "opcode-\(opcode)")
        }
    }

    // MARK: - Lifecycle

    private func createEntity(id: Int, kind: Kind, name: String) {
        guard records[id] == nil else { return }
        // ModelEntity everywhere except anchors: it is the same cost as Entity
        // and it is what carries the physics helpers, so a body on a Group or an
        // Asset behaves exactly like a body on a Mesh.
        let entity: Entity = kind == .anchor ? AnchorEntity(world: .zero) : ModelEntity()
        entity.name = name
        entity.components.set(ScriptingEntityComponent(sceneID: sceneIdentifier, entityID: id))
        let record = Record(id: id, kind: kind, entity: entity)
        records[id] = record
        root.addChild(entity)
        applyDebugModelView(to: record)
    }

    // MARK: - Resource references

    /// Moves a record from one cached mesh to another. Pairing retain with
    /// release here, rather than at every call site, is what keeps the counts
    /// honest: a record has exactly one mesh key at a time.
    func bindMesh(_ record: Record, key: String?) {
        guard record.meshCacheKey != key else { return }
        if let previous = record.meshCacheKey { resources.releaseMesh(previous) }
        record.meshCacheKey = key
        if let key { resources.retainMesh(key) }
    }

    func bindMaterials(_ record: Record, keys: [ScriptingMaterialKey]) {
        guard record.materialCacheKeys != keys else { return }
        for previous in record.materialCacheKeys { resources.releaseMaterial(previous) }
        record.materialCacheKeys = keys
        for key in keys { resources.retainMaterial(key) }
    }

    func bindShape(_ record: Record, key: String?) {
        guard record.shapeCacheKey != key else { return }
        if let previous = record.shapeCacheKey { resources.releaseShape(previous) }
        record.shapeCacheKey = key
        if let key { resources.retainShape(key) }
    }

    private func destroyEntity(id: Int) {
        guard let record = records[id] else { return }
        // A joint id, or a joint that referenced the destroyed body. The joints
        // are dropped and the component rewritten while the entity is still in
        // the scene, which is what RealityKit's deferred deletion requires.
        let jointsReferenced = jointSpecs.contains { $0.key == id || $0.value.bodyA == id || $0.value.bodyB == id }
        if jointsReferenced {
            jointSpecs = jointSpecs.filter { $0.key != id && $0.value.bodyA != id && $0.value.bodyB != id }
            rebuildJoints()
        }
        records[id] = nil
        // The references go first: the uuid drop below, and any later
        // eviction, may only take a resource nothing draws any more.
        bindMesh(record, key: nil)
        bindMaterials(record, keys: [])
        bindShape(record, key: nil)
        // The mesh a buffer geometry produced is as big as its buffers, so it
        // goes as soon as nothing draws it.
        if let uuid = record.geometryUUID,
           !records.values.contains(where: { $0.geometryUUID == uuid }) {
            resources.releaseGeometry(uuid: uuid)
        }
        record.animation?.stop()
        record.animation = nil
        record.assetContainer?.removeFromParent()
        record.assetContainer = nil
        // SPEC 14.1 and 14.2: destroying an object releases its media. Without
        // this the AVPlayer kept playing for the life of the process and the
        // playback controller's completion handler held the record alive.
        releaseAudio(on: record)
        releaseVideo(on: record)
        if cameraRecordID == id { releaseCamera() }
        record.extras = nil
        // Drop the entity's components before it goes, so the mesh, material and
        // shape it referenced are released even if something else still holds
        // the entity for a moment.
        (record.entity as? ModelEntity)?.model = nil
        record.mesh = nil
        record.materialSpec = nil

        let tookPartInPhysics = record.entity.components[PhysicsBodyComponent.self] != nil
            || record.entity.components[GeometricPinsComponent.self] != nil
        if tookPartInPhysics {
            // Only the joints go now. The pins, the body and the entity are all
            // still referenced by the constraint RealityKit has queued for
            // deferred deletion, so they follow a frame later.
            ScriptingPhysicsGraveyard.shared.stage(record.entity)
        } else {
            record.entity.components.remove(CollisionComponent.self)
            record.entity.removeFromParent()
        }
        record.lightHolder?.removeFromParent()
        record.lightHolder = nil
        clearAmbientLight(for: record)
        worldGroups.remove(id)
        activeCollisions = activeCollisions.filter { $0.low != id && $0.high != id }
        lastContacts = lastContacts.filter { $0.key.low != id && $0.key.high != id }
    }

    private func setParent(id: Int, parentID: Int) {
        guard let record = records[id] else { return }
        if parentID == -1 {
            record.entity.removeFromParent()
            return
        }
        guard let parent = entity(for: parentID) else { return }
        parent.addChild(record.entity, preservingWorldTransform: false)
    }

    private func applyTransform(id: Int, command: JavaScriptArrayReader) {
        guard let record = records[id] else { return }
        setTransform(
            on: record,
            translation: SIMD3(command.float(2), command.float(3), command.float(4)),
            rotation: simd_quatf(
                ix: command.float(5),
                iy: command.float(6),
                iz: command.float(7),
                r: command.float(8)
            ),
            scale: SIMD3(command.float(9), command.float(10), command.float(11))
        )
    }

    /// The batched form: one typed-array read for the whole frame, then a tight
    /// loop of single `Transform` assignments. The core reuses its buffer across
    /// frames, so the array is copied out before anything else runs.
    private func applyTransforms(command: JavaScriptArrayReader) {
        guard let packed = command.float32Array(2), packed.count >= 11 else { return }
        let stride = 11
        var index = 0
        while index + stride <= packed.count {
            let raw = packed[index]
            guard raw.isFinite, let id = Int(exactly: raw.rounded()) else {
                warnings.warnOnce(
                    "A transforms record carried a non-finite id and was skipped",
                    key: "transforms-bad-id"
                )
                index += stride
                continue
            }
            if let record = records[id] {
                setTransform(
                    on: record,
                    translation: SIMD3(packed[index + 1], packed[index + 2], packed[index + 3]),
                    rotation: simd_quatf(
                        ix: packed[index + 4],
                        iy: packed[index + 5],
                        iz: packed[index + 6],
                        r: packed[index + 7]
                    ),
                    scale: SIMD3(packed[index + 8], packed[index + 9], packed[index + 10])
                )
            }
            index += stride
        }
    }

    private func setTransform(
        on record: Record,
        translation: SIMD3<Float>,
        rotation: simd_quatf,
        scale: SIMD3<Float>
    ) {
        let normalized = simd_length_squared(rotation.vector) > 1e-12
            ? simd_normalize(rotation)
            : simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
        let entity = record.entity
        switch Self.transformStrategy {
        case .assign:
            entity.transform = Transform(scale: scale, rotation: normalized, translation: translation)
        case .component:
            entity.components.set(Transform(scale: scale, rotation: normalized, translation: translation))
        case .selective:
            var current = entity.transform
            var changed = false
            if current.translation != translation { current.translation = translation; changed = true }
            if current.rotation.vector != normalized.vector { current.rotation = normalized; changed = true }
            if current.scale != scale { current.scale = scale; changed = true }
            if changed { entity.transform = current }
        }
        // A TRANSFORM on a dynamic body is a teleport that also zeroes velocity.
        if record.bodyType == "dynamic", record.entity.components[PhysicsMotionComponent.self] != nil {
            record.entity.components.set(PhysicsMotionComponent())
            record.previousWorldPosition = nil
            record.previousWorldOrientation = nil
            record.linearVelocity = .zero
            record.angularVelocity = .zero
        }
    }

    // MARK: - Geometry and materials

    private func applyGeometry(id: Int, command: JavaScriptArrayReader, context: JSContext) {
        guard let record = records[id], let model = record.entity as? ModelEntity else { return }
        guard let descriptor = command.dictionary(2, in: context) else { return }
        let type = descriptor["type"] as? String ?? ""
        // `parameters` is null for a plain BufferGeometry.
        let parameters = descriptor["parameters"] as? [String: Any] ?? [:]
        let buffers = ScriptingGeometryFactory.Buffers(
            positions: command.float32Array(3) ?? [],
            normals: command.float32Array(4),
            uvs: command.float32Array(5),
            indices: command.uint32Array(6)
        )
        // The descriptor is recorded even when no native mesh can be built, so
        // the mirror still reports what the core sent.
        record.geometryType = type
        record.geometryParameters = parameters
        // SPEC 14.12: `geometry.groups` says where a mesh *may* be split. three.js
        // gives an ordinary box six groups, one per face, so splitting on the
        // descriptor alone turns every box into a six part mesh: six material
        // slots and six draw calls each, which halved the frame rate at 1500
        // objects. A mesh is split only when the object really carries a
        // material per part; otherwise it draws the shared single part
        // resource, and the split is built on demand if a material array turns
        // up for it in the same batch.
        let groups = ScriptingGeometryFactory.groups(from: descriptor)
        record.geometryRawGroupCount = (descriptor["groups"] as? [Any])?.count
        let wantsSplit = groups != nil && (record.materialSpecs?.count ?? 0) > 1
        record.geometryGroups = wantsSplit ? groups.map(ScriptingGeometryFactory.partCount) : nil
        let base = ScriptingGeometryFactory.cacheKey(
            type: type,
            parameters: parameters,
            uuid: descriptor["uuid"] as? String,
            revision: ScriptingGeometryFactory.revisionToken(descriptor["revision"]),
            buffers: buffers
        )
        record.geometryKey = base
        // A split mesh is still one shared resource: the groups are part of its
        // identity, not a reason to give every object a copy.
        let cacheKey = wantsSplit
            ? base.map { $0 + "|groups=" + ScriptingGeometryFactory.groupSignature(groups!) }
            : base
        if let groups {
            pendingGroupedGeometry[id] = GroupedGeometry(key: base, groups: groups, buffers: buffers)
        } else {
            pendingGroupedGeometry[id] = nil
        }
        let uuid = descriptor["uuid"] as? String
        record.geometryUUID = uuid
        guard let mesh = resources.mesh(forKey: cacheKey, uuid: uuid, build: {
            if wantsSplit, let groups {
                return ScriptingGeometryFactory.meshFromBuffers(buffers, groups: groups)
                    ?? ScriptingGeometryFactory.mesh(
                        type: type,
                        parameters: parameters,
                        buffers: buffers,
                        warnings: self.warnings
                    )
            }
            return ScriptingGeometryFactory.mesh(
                type: type,
                parameters: parameters,
                buffers: buffers,
                warnings: self.warnings
            )
        }) else {
            // SPEC 14.3/12: the core already warns once for a mesh whose
            // geometry has no vertices ("… has a BufferGeometry with no
            // vertices and draws nothing"), so saying it again here would put
            // the same fact in the dump twice and only on this backend. What
            // is worth a warning is a geometry that *had* vertices and still
            // produced nothing: that is a native failure the core cannot see.
            // A geometry whose positions arrived as an empty typed array is
            // the empty one the core already described. A *buffer-less* re-send
            // (SPEC 5: null buffers for a uuid already delivered) that reaches
            // here is the NR-01 failure — the cache lost an entry something is
            // still drawing — and must be loud.
            let wasReSentWithoutBuffers = command.isNullish(3)
            if !buffers.positions.isEmpty || !parameters.isEmpty || wasReSentWithoutBuffers {
                warnings.warnOnce(
                    "Geometry '\(type)' produced no mesh and was skipped.",
                    key: "geometry-empty-\(type)"
                )
            }
            return
        }
        bindMesh(record, key: cacheKey)
        record.mesh = mesh
        var materials = model.model?.materials ?? [defaultMaterial()]
        // A grouped mesh needs one material per part; the array the script gave
        // is re-indexed onto the new mesh, and any short fall repeats the last.
        // Only a grouped geometry can have more than one part, and asking a
        // shared mesh for its part count once per object costs more than the
        // whole load, so the question is only asked when it can matter.
        // The part count is known from the groups, so a shared mesh is never
        // asked for it per object.
        let parts = record.geometryGroups ?? 1
        if parts > materials.count, let specs = record.materialSpecs {
            materials = (0..<parts).map { nativeMaterial(for: specs[min($0, specs.count - 1)]) }
        } else if parts > materials.count, let last = materials.last {
            materials.append(contentsOf: Array(repeating: last, count: parts - materials.count))
        }
        model.model = ModelComponent(mesh: mesh, materials: materials)
        refreshCollisionShape(record)
    }

    private func applyMaterial(id: Int, spec: ScriptingMaterialSpec) {
        guard let record = records[id], let model = record.entity as? ModelEntity else { return }

        // A property change rewrites the properties that moved on the material
        // this record already owns. Rebuilding cost 0.63 ms per command; a
        // colour tween now costs one native write.
        if var existing = record.nativeMaterial,
           let previous = record.materialSpec,
           !ScriptingMaterialFactory.needsRebuild(from: previous, to: spec) {
            let writes = ScriptingMaterialFactory.update(
                &existing,
                from: previous,
                to: spec,
                textures: textures,
                warnings: warnings
            )
            record.materialSpec = spec
            resources.countMaterialWrites(writes)
            // The material was patched in place, so this record no longer draws
            // whatever the cache holds under its old key.
            bindMaterials(record, keys: [])
            guard writes > 0 else { return }
            record.nativeMaterial = existing
            if var component = model.model {
                component.materials = [existing]
                model.model = component
            }
            return
        }

        record.materialSpec = spec
        let materialKey = spec.cacheKey(textures: textures)
        let material = resources.material(forKey: materialKey) {
            ScriptingMaterialFactory.material(
                for: spec,
                textures: self.textures,
                warnings: self.warnings
            )
        }
        bindMaterials(record, keys: [materialKey].compactMap { $0 })
        record.nativeMaterial = material
        if var component = model.model {
            component.materials = [material]
            model.model = component
        } else if let mesh = record.mesh {
            model.model = ModelComponent(mesh: mesh, materials: [material])
        }
    }

    /// O(referrers), not O(all records): a scene of 10 000 meshes with 300
    /// textures used to rescan every record 300 times during load.
    private func reapplyMaterials(referencing textureID: Int) {
        guard let referrers = materialsByTexture[textureID] else { return }
        for recordID in referrers {
            guard let record = records[recordID], let spec = record.materialSpec else { continue }
            // The texture resource has changed, so the native material is
            // rebuilt rather than patched.
            record.nativeMaterial = nil
            applyMaterial(id: recordID, spec: spec)
        }
    }

    func materialReferrerCount(for textureID: Int) -> Int {
        materialsByTexture[textureID]?.count ?? 0
    }

    /// Test seam: the load completion path without a real texture resource.
    func reapplyMaterialsForTesting(referencing textureID: Int) {
        reapplyMaterials(referencing: textureID)
    }

    func indexMaterial(_ spec: ScriptingMaterialSpec, for id: Int) {
        for textureID in spec.referencedTextureIDs {
            materialsByTexture[textureID, default: []].insert(id)
        }
    }

    /// One shared white material for meshes whose `material` command has not
    /// arrived yet. Building one per mesh cost a native round trip each.
    private func defaultMaterial() -> any RealityKit.Material {
        if let cached = cachedDefaultMaterial { return cached }
        let material = PhysicallyBasedMaterial()
        cachedDefaultMaterial = material
        return material
    }

    // MARK: - Presentation flags

    private func applyShadow(id: Int, casts: Bool, receives: Bool) {
        guard let record = records[id] else { return }
        record.castShadow = casts
        if casts {
            record.entity.components.set(DynamicLightShadowComponent(castsShadow: true))
        } else {
            record.entity.components.remove(DynamicLightShadowComponent.self)
        }
        // RealityKit surfaces always receive shadows and three.js defaults
        // receiveShadow to false on every mesh, so the value is accepted
        // silently rather than warning on every scene.
        record.receiveShadow = receives
    }

    private func applyOpacity(id: Int, value: Float) {
        guard let record = records[id] else { return }
        guard value.isFinite else {
            warnings.warnOnce(
                "Object3D.opacity was not a finite number and was ignored",
                key: "opacity-not-finite"
            )
            return
        }
        if value >= 1 {
            record.entity.components.remove(OpacityComponent.self)
        } else {
            record.entity.components.set(OpacityComponent(opacity: value))
        }
    }

    private func applyBillboard(id: Int, enabled: Bool) {
        guard let record = records[id] else { return }
        if enabled {
            record.entity.components.set(BillboardComponent())
        } else {
            record.entity.components.remove(BillboardComponent.self)
        }
    }

    private func applyGroundingShadow(id: Int, enabled: Bool) {
        guard let record = records[id] else { return }
        if enabled {
            record.entity.components.set(GroundingShadowComponent(castsShadow: true))
        } else {
            record.entity.components.remove(GroundingShadowComponent.self)
        }
    }

    private func applyHoverEffect(id: Int, style: String?) {
        guard let record = records[id] else { return }
        record.hoverEffect = style
#if os(visionOS)
        guard let style else {
            record.entity.components.remove(HoverEffectComponent.self)
            return
        }
        // This SDK's HoverEffectComponent offers spotlight, highlight and
        // shader only; there is no lift style to map onto.
        if style == "lift" {
            warnings.warnOnce(
                "hoverEffect \"lift\" has no RealityKit equivalent and renders as \"highlight\"",
                key: "hover-lift"
            )
        }
        let effect: HoverEffectComponent.HoverEffect = switch style {
        case "spotlight": .spotlight(.default)
        default: .highlight(.default)
        }
        record.entity.components.set(HoverEffectComponent(effect))
#else
        // Accepted with no visual on macOS, per SPEC 3.2. No warning.
        _ = style
        _ = record
#endif
    }

    private func applyRenderOrder(id: Int, order: Int) {
        guard let record = records[id] else { return }
        record.renderOrder = order
#if os(visionOS)
        record.entity.components.set(
            ModelSortGroupComponent(group: ModelSortGroup(depthPass: nil), order: Int32(order))
        )
#else
        _ = record
        if order != 0 {
            warnings.warnOnce(
                "Object3D.renderOrder is unsupported on macOS; ModelSortGroupComponent is visionOS only",
                key: "render-order-macos"
            )
        }
#endif
    }

    private func applyManipulable(id: Int, enabled: Bool) {
        guard let record = records[id] else { return }
        record.manipulable = enabled
#if os(visionOS)
        if enabled {
            ManipulationComponent.configureEntity(record.entity)
            record.entity.components.set(ManipulationComponent())
        } else {
            record.entity.components.remove(ManipulationComponent.self)
        }
#else
        _ = record
        if enabled {
            warnings.warnOnce(
                "Object3D.manipulable is unsupported on macOS; ManipulationComponent is visionOS only",
                key: "manipulable-macos"
            )
        }
#endif
    }

    private func applyInteractive(id: Int, payload: [String: Any]) {
        guard let record = records[id] else { return }
        let tap = payload["tap"] as? Bool ?? false
        let hover = payload["hover"] as? Bool ?? false
        let drag = payload["drag"] as? Bool ?? false
        let manipulation = payload["manipulation"] as? Bool ?? false
        let collision = payload["collision"] as? Bool ?? false
        record.interactive = (tap, hover, drag, manipulation, collision)
        if tap || hover || drag {
            record.entity.components.set(InputTargetComponent())
            refreshCollisionShape(record)
        } else {
            record.entity.components.remove(InputTargetComponent.self)
        }
    }

    // MARK: - Scene wiring

    let sceneIdentifier: UUID = UUID()

    private func subscribeToSceneEventsIfNeeded() {
        guard !didSubscribe, let scene = root.scene else { return }
        didSubscribe = true
        subscriptions.append(scene.subscribe(to: CollisionEvents.Began.self) { [weak self] event in
            MainActor.assumeIsolated {
                self?.report(
                    collision: event.entityA,
                    event.entityB,
                    began: true,
                    impulse: event.impulse,
                    position: event.position,
                    normal: event.impulseDirection
                )
            }
        })
        subscriptions.append(scene.subscribe(to: CollisionEvents.Ended.self) { [weak self] event in
            MainActor.assumeIsolated {
                // Ended carries no contact, so the pair's last known one is used.
                self?.report(
                    collision: event.entityA,
                    event.entityB,
                    began: false,
                    impulse: 0,
                    position: nil,
                    normal: nil
                )
            }
        })
#if os(visionOS)
        subscriptions.append(scene.subscribe(to: ManipulationEvents.WillBegin.self) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let record = self.record(forEntity: event.entity) else { return }
                record.isManipulated = true
                self.dispatch?("manipulationstart", record.id, nil)
            }
        })
        subscriptions.append(scene.subscribe(to: ManipulationEvents.DidUpdateTransform.self) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let record = self.record(forEntity: event.entity) else { return }
                self.dispatch?("manipulation", record.id, nil)
            }
        })
        subscriptions.append(scene.subscribe(to: ManipulationEvents.WillEnd.self) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let record = self.record(forEntity: event.entity) else { return }
                record.isManipulated = false
                self.dispatch?("manipulationend", record.id, nil)
            }
        })
#endif
    }

    /// Test seam for the collision payload, which otherwise only arrives from
    /// a RealityKit scene subscription.
    func reportCollisionForTesting(
        _ a: Entity,
        _ b: Entity,
        began: Bool,
        impulse: Float,
        position: SIMD3<Float>?,
        normal: SIMD3<Float>?
    ) {
        report(collision: a, b, began: began, impulse: impulse, position: position, normal: normal)
    }

    private func report(
        collision a: Entity,
        _ b: Entity,
        began: Bool,
        impulse: Float,
        position: SIMD3<Float>?,
        normal: SIMD3<Float>?
    ) {
        // The core mirrors the event onto `other`, so it is dispatched once.
        guard let recordA = nearestRecord(from: a), let recordB = nearestRecord(from: b) else { return }
        // SPEC 3.7: a collision needs at least one rigid body. Two hit-test
        // colliders share a group and a mask, so RealityKit reports them
        // touching even though neither is simulated.
        guard recordA.bodyType != nil || recordB.bodyType != nil else { return }
        let pair = CollisionPair(recordA.id, recordB.id)

        let contact: (point: SIMD3<Float>, normal: SIMD3<Float>)
        if began {
            guard activeCollisions.insert(pair).inserted else { return }
            let resolvedNormal = normal.map { simd_length($0) > 1e-6 ? simd_normalize($0) : $0 } ?? .zero
            contact = (position ?? .zero, resolvedNormal)
            lastContacts[pair] = contact
        } else {
            guard activeCollisions.remove(pair) != nil else { return }
            contact = lastContacts.removeValue(forKey: pair)
                ?? (
                    (a.position(relativeTo: nil) + b.position(relativeTo: nil)) / 2,
                    SIMD3<Float>.zero
                )
        }

        dispatch?(began ? "collisionstart" : "collisionend", recordA.id, [
            "point": [contact.point.x, contact.point.y, contact.point.z],
            "normal": [contact.normal.x, contact.normal.y, contact.normal.z],
            "impulse": impulse,
            "other": recordB.id,
        ])
    }

    /// True while the load that started `generation` is still the current one.
    func isCurrent(_ generation: Int) -> Bool {
        !isDisposed && generation == loadGeneration
    }

    /// Clears everything the running script built without retiring the
    /// applier, for a hot reload that keeps the same JavaScript context
    /// (SPEC 14.10). The core restarts its object ids, so nothing of the old
    /// scene may survive.
    func reset() {
        tearDown()
        isDisposed = false
    }

    func dispose() {
        tearDown()
        isDisposed = true
    }

    private func tearDown() {
        loadGeneration += 1
        for subscription in subscriptions { subscription.cancel() }
        subscriptions.removeAll()

        // Order matters. The joints are emptied out of the component that is
        // still on the root: removing the component instead leaves RealityKit's
        // deferred deletion list undrained until something recreates it, and it
        // then frees constraints whose entities are long gone. Writing an empty
        // list marks the component dirty, so the deletion runs on this frame
        // while the pins, bodies and entities the constraints point at are all
        // still intact. Those follow a few frames later.
        jointSpecs.removeAll()
        rebuildJoints()
        for record in records.values {
            record.animation?.stop()
            if record.entity.components[PhysicsBodyComponent.self] != nil
                || record.entity.components[GeometricPinsComponent.self] != nil {
                ScriptingPhysicsGraveyard.shared.stage(record.entity)
            } else {
                record.entity.removeFromParent()
            }
        }
        records.removeAll()
        activeCollisions.removeAll()
        lastContacts.removeAll()
        textures.removeAll()
        resources.removeAll()
        textureIDsByURL.removeAll()
        materialsByTexture.removeAll()
        assetIDsByURL.removeAll()
        jointSpecs.removeAll()
        worldGroups.removeAll()
        environmentEntity?.removeFromParent()
        environmentEntity = nil
        ambientLight = nil
        explicitEnvironment = nil
        environmentURL = nil
        environmentIntensity = 1
        loadsInFlight.removeAll()
        // SWIFT-04: the root is shared with the next script, so every component
        // this applier put on it comes off again.
        root.components.remove(ImageBasedLightReceiverComponent.self)
        root.components.remove(PhysicsSimulationComponent.self)
        root.components.remove(AudioMixGroupsComponent.self)
        audioMasterVolume = 1
        audioGroupVolumes.removeAll()
        cameraSpec = nil
        sceneUnderstandingSpec.removeAll()
        renderOptions.removeAll()
        environmentIntensityExponent = 1
    }

    // MARK: - Native driven objects

    func isAttachedToRoot(_ entity: Entity) -> Bool {
        var node: Entity? = entity
        while let current = node {
            if current === root { return true }
            node = current.parent
        }
        return false
    }

    func nearestRecord(from entity: Entity) -> Record? {
        var node: Entity? = entity
        while let current = node {
            if let record = record(forEntity: current) { return record }
            node = current.parent
        }
        return nil
    }

    // MARK: - Environment plumbing

    /// The receiver goes on the scene root only. RealityKit resolves it down
    /// the hierarchy, and one component instead of one per mesh keeps a scene
    /// of 1500 meshes off a per-entity component write.
    func setEnvironmentEntity(_ entity: Entity?) {
        environmentEntity = entity
        guard let entity else {
            root.components.remove(ImageBasedLightReceiverComponent.self)
            return
        }
        root.components.set(ImageBasedLightReceiverComponent(imageBasedLight: entity))
    }

    var currentEnvironmentEntity: Entity? { environmentEntity }

    func flushPendingLightDirections() {
        for record in records.values {
            guard let direction = record.pendingLightDirection, let holder = record.lightHolder else { continue }
            record.pendingLightDirection = nil
            let local = record.entity.convert(direction: direction, from: nil)
            holder.orientation = Self.orientation(pointingMinusZAlong: local)
        }
    }

    /// RealityKit lights emit along the entity's -Z axis.
    static func orientation(pointingMinusZAlong direction: SIMD3<Float>) -> simd_quatf {
        let length = simd_length(direction)
        guard length > 1e-6 else { return simd_quatf(ix: 0, iy: 0, iz: 0, r: 1) }
        let forward = direction / length
        let reference = SIMD3<Float>(0, 0, -1)
        let dot = simd_dot(reference, forward)
        if dot > 0.999999 { return simd_quatf(ix: 0, iy: 0, iz: 0, r: 1) }
        if dot < -0.999999 { return simd_quatf(angle: .pi, axis: SIMD3(0, 1, 0)) }
        let axis = simd_normalize(simd_cross(reference, forward))
        return simd_quatf(angle: acos(max(-1, min(1, dot))), axis: axis)
    }

}

/// A body counts as asleep once its speed stays under `sleepSpeedThreshold`
/// for `sleepFrameThreshold` consecutive frames.
enum ScriptingMotionSampling {
    static let sleepSpeedThreshold: Float = 1e-3
    static let sleepFrameThreshold = 10
}

extension SIMD4 where Scalar == Float {
    var spatialXYZ: SIMD3<Float> { SIMD3(x, y, z) }
}
