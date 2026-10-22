const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

function voice(name, group) {
  const audio = new S.Audio();
  audio.name = name;
  audio.setBuffer(new S.AudioLoader().load(`sounds/${name}.wav`));
  if (group !== undefined) audio.group = group;
  scene.add(audio);
  return audio;
}

// The default bus, two named buses, and a name that is not usable.
const narration = voice("narration");
const theme = voice("theme", "music");
const sting = voice("sting", "music");
const step = voice("step", "sfx");
const odd = voice("odd", 42);

S.audio.setGroupVolume("music", 0.25);
S.audio.setGroupVolume("sfx", 0.8);
S.audio.masterVolume = 0.9;

const probe = new S.Object3D();
probe.name = "probe";
probe.userData.groups = [narration.group, theme.group, sting.group, step.group, odd.group];
probe.userData.mixerGroups = S.audio.groups;
scene.add(probe);

S.mount(scene);
