const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

const room = new S.AmbientAudio();
room.name = "room";
room.position.set(0, 1.2, 0);
room.setBuffer(new S.AudioLoader().load("sounds/room.wav"));
room.setLoop(true);
room.setVolume(0.3);
room.group = "ambience";
room.play();
scene.add(room);

room.userData.isObject3D = room.isObject3D === true;
room.userData.isAudio = room.isAudio === true;
// AmbientAudio is not spatial: it has no distance model of its own.
room.userData.spatialSetter = typeof room.setRefDistance;

S.audio.setGroupVolume("ambience", 0.6);

S.mount(scene);
