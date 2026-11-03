const Spatial = require("spatial");
const S = Spatial;

const scene = new S.Scene();

// SPEC 3.5 lists blob among the allowed schemes: a page handing a script a
// blob url for a fetched buffer must reach the consumer unchanged, not be
// normalised (the url after the scheme is itself a url).
const screen = new S.VideoScreen({ url: "blob:https://example.com/9f5c-4a7d", width: 1 });
screen.name = "screen";
scene.add(screen);

const texture = new S.TextureLoader().load("blob:https://example.com/tex-1");
const panel = new S.Mesh(new S.PlaneGeometry(0.3, 0.3), new S.MeshStandardMaterial({ map: texture }));
panel.name = "panel";
scene.add(panel);

const sound = new S.Audio();
sound.name = "sound";
sound.setBuffer(new S.AudioLoader().load("blob:https://example.com/audio-1"));
scene.add(sound);

panel.userData.textureUrl = texture.url;
panel.userData.videoUrl = screen.url;

S.mount(scene);
