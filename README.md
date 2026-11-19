# Wincode Node Manager

Finds the Wincode nodes on a lighting network, configures them, commissions a whole rig and shows what every
node is doing — eDMX nodes, pixel nodes, hubs and kinetic winches.

The hardware is still being designed, so the program comes with **virtual devices**. They speak the same protocol
the ESP32 firmware will: [docs/DEVICE-API.md](docs/DEVICE-API.md) is the firmware specification, and
[`web/js/vdevice.js`](web/js/vdevice.js) is its executable reference.

**Try it:** https://samcho93.github.io/wincodeNodeManager/ (demo with in-page virtual devices) ·
Manual: [English](https://samcho93.github.io/wincodeNodeManager/manual/en.html) · [한국어](https://samcho93.github.io/wincodeNodeManager/manual/ko.html)

## Run

```bash
npm start
```

Opens on http://127.0.0.1:7760 with a virtual fleet of eight devices (2 eDMX, 2 pixel, 1 hub, 3 winches).
No dependencies; Node 18 or newer.

| Command | What |
|---|---|
| `npm start` | Manager + virtual fleet |
| `npm run manager` | Manager only — for real nodes |
| `npm run virtual` | Virtual fleet only |

Opened without the server (a static web host), the page runs the same virtual fleet inside the browser ("Demo").

## Screens

- **Devices** — the list by type; for the selected device its live state, manual control (winch: home, jog, go to,
  release; hub: play / record presets; ports: test patterns) and its configuration. Nothing is written until **Apply**.
- **Monitor** — one card per device: temperature, frame rate and level per port, winch position, playback, alarms.
- **Universes** — every universe the rig listens to, device by device, with duplicates pointed out.
- **Commissioning tools** — number the universes in one go, name the devices, copy a configuration to devices of the
  same model, identify / reboot, back up and restore the whole rig as one JSON file.
- **Event log** — devices found, lost and back, alarms, what was applied.

## How it works

```
browser  ──HTTP──▶  manager server (7760)  ──UDP 7788 discovery──▶  nodes
                                            ──HTTP /api/…────────▶  nodes (real or virtual, 7801…)
```

A browser cannot broadcast or call devices on other origins; the small server does that and keeps no
configuration of its own — the devices are the source of truth. The virtual devices also listen for Art-Net
(6454) and sACN (5568) when those ports are free, so a real console moves the virtual winches.

## Not done yet

- Firmware update (OTA) from the manager.
- RDM device list behind an eDMX port.
- Tested only against the virtual devices — no real hardware exists yet.
