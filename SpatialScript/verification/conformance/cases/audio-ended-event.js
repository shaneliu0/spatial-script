const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();
scene.userData.bubbled = 0;

const chime = new S.Audio();
chime.name = "chime";
chime.setBuffer(new S.AudioLoader().load("sounds/chime.wav"));
chime.userData.order = [];
chime.play();
scene.add(chime);

chime.onEnded = function onEnded() {
  chime.userData.order.push("callback");
  chime.userData.playingInCallback = chime.isPlaying;
};

chime.addEventListener("ended", (event) => {
  chime.userData.order.push("event");
  chime.userData.eventType = event.type;
  chime.userData.eventTarget = event.target.name;
  chime.userData.playingInEvent = chime.isPlaying;
});

// The event bubbles to the parent like every other object event (SPEC 3.8).
scene.addEventListener("ended", () => {
  scene.userData.bubbled += 1;
});

S.mount(scene);
