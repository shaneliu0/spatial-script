const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const marker = new S.Group();
marker.name = "marker";
scene.add(marker);

// SPEC 14.14: every phase 2 capability is honest per backend. The three.js
// backend has no shader graph and no scene understanding.
const capabilities = S.env.capabilities;
marker.userData.audio = capabilities.audio;
marker.userData.video = capabilities.video;
marker.userData.camera = capabilities.camera;
marker.userData.characterController = capabilities.characterController;
marker.userData.forceFields = capabilities.forceFields;
marker.userData.skeleton = capabilities.skeleton;
marker.userData.blendShapes = capabilities.blendShapes;
marker.userData.shaderGraph = capabilities.shaderGraph;
marker.userData.sceneUnderstanding = capabilities.sceneUnderstanding;
marker.userData.controllers = capabilities.controllers;
marker.userData.hostFunctions = capabilities.hostFunctions;
marker.userData.accessibility = capabilities.accessibility;
marker.userData.keys = Object.keys(capabilities).sort();

S.mount(scene);
