# Wincode Node Manager

Configuration, commissioning and monitoring of Wincode nodes (eDMX, pixel, hub, kinetic winch). Details: [README.md](README.md).
Sister projects: `D:\Work\Web\wincodeMovingHead` (simulator), `D:\Work\Web\wincodeDmxStudio` (console). Same style: Node server + static ES modules, no bundler, no dependencies.

## Run
- `npm start` → http://127.0.0.1:7760 with the virtual fleet (HTTP 7801…, discovery UDP 7788). `npm run manager` = no virtual devices.
- Claude preview: `nodemanager` in the simulator's `.claude/launch.json`.

## Layout
- `web/js/vdevice.js` — the device model (pure logic). It is the reference for the firmware: change it, `docs/DEVICE-API.md` and the forms in `main.js` together.
- `web/js/sim.js` — the Simulator tab (winches and pixel strips drawn from `VDevice.frame()`, about 15 Hz; virtual devices only). DMX reaches the virtual nodes by Art-Net (also on 127.0.0.2) / sACN in `server/virtual.mjs`, and by `BroadcastChannel('wmh-dmx')` in demo mode (`api.js`).
- Firmware and circuit diagrams live in `D:\Work\Web\wincodeNodeHardware`; it implements `docs/DEVICE-API.md` — change the two together.
- `server/virtual.mjs` — wraps `VDevice` in HTTP + discovery. `server/index.mjs` — discovery, 1 Hz supervision, proxy `/api/dev/<id>/…`.
- `web/js/api.js` — `live` (server) or `demo` (fleet inside the page); `main.js` must work with both.
- `web/js/main.js` — one draw function per tab. The detail pane keeps a draft (`S.draft`); only **Apply** writes. The 1 s refresh redraws the status box only, so that typing is not interrupted.

## Rules
- All user-visible text and code comments are English. The one exception is the Korean manual and tutorials (`web/manual/ko.html`, `tutorial-ko.html`).
- Manual: `web/manual/en.html` and `ko.html` are kept in step (same chapters, same screenshots in `img/`); so are `tutorial-en.html` / `tutorial-ko.html` (six jobs on the virtual fleet, screenshots `img/t*.png`). Run a tutorial against the fleet again after changing what it touches. Screenshots are 1180×780 captures of the live page with the virtual fleet.
- The devices are the source of truth; the manager stores nothing.
- The API is versioned (`API_VERSION`): add fields, never change the meaning of one; unknown fields are ignored on both sides.
- No device-model `if`s in the UI beyond the four types; a new model = a line in `MODELS`.
- Motion safety belongs to the firmware, not to this program.

## Verifying
- Page console: `WNM.api`, `WNM.S`. `WNM.api.action(id, { action: 'fault', kind: 'overtemp' | 'stall' | null })` on virtual devices.
- `curl http://127.0.0.1:7801/api/status` talks to a virtual device directly.
