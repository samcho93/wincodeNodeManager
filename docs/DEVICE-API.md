# Wincode node — device API, version 1

What a Wincode node (ESP32 firmware) must implement so that the Node Manager can find, configure and watch it.
The executable reference is [`web/js/vdevice.js`](../web/js/vdevice.js): the virtual devices run exactly this
specification. When the two disagree, the code is right and this file has to be corrected.

Device types: `edmx` (Art-Net / sACN ↔ DMX512), `pixel` (Art-Net / sACN → LED pixels), `hub` (record / playback),
`winch` (kinetic winch with a pixel output).

## 1. Transport

| What | How |
|---|---|
| Discovery | UDP port **7788**, JSON text datagrams |
| Configuration, status, commands | HTTP/1.1 on the device (port 80 unless the `hello` says otherwise), JSON bodies, UTF-8 |
| Show data | Art-Net (UDP 6454) and sACN / E1.31 (UDP 5568, multicast) — unchanged standard protocols |

Rules for every HTTP answer: `Content-Type: application/json`, `Cache-Control: no-store`, and
`Access-Control-Allow-Origin: *` (so the device's own page and tools can call it). Errors answer with a 4xx status
and `{ "ok": false, "error": "text for a person" }`. Unknown fields in a request are ignored, never an error —
that is what lets a newer manager talk to older firmware.

## 2. Discovery

The manager broadcasts (limited broadcast, every interface's directed broadcast, and 127.0.0.1 for virtual nodes):

```json
{ "t": "discover", "v": 1 }
```

Every node answers, unicast to the sender's address and port, within 500 ms (add 0–200 ms of random delay so a
large rig does not answer in one burst):

```json
{ "t": "hello", "v": 1, "api": 1, "id": "WNA1B755", "type": "winch", "model": "WN-WINCH",
  "name": "Winch 1", "fw": "1.0.3", "hw": "A", "ports": 1, "ip": "192.168.1.55", "port": 80 }
```

- `id` — permanent and unique: `WN` + the last three bytes of the MAC address in hex. It never changes; backups are matched by it.
- `ip` / `port` — where the HTTP API is. `0.0.0.0` or a missing `ip` means "use the datagram's source address".
- A node may also send an unsolicited `hello` once after it gets its address, so that it shows up without a scan.

A node on another subnet is added by its address; the manager then reads `/api/info`.

## 3. HTTP endpoints

### `GET /api/info` — identity (never changes while running)

```json
{ "api": 1, "id": "WNA1B755", "type": "winch", "model": "WN-WINCH", "name": "Winch 1",
  "fw": "1.0.3", "hw": "A", "ports": 1 }
```

`virtual: true` is present only on simulated devices. Models: `WN-DMX2/4/8` (edmx), `WN-PIX4/8` (pixel),
`WN-HUB` (hub), `WN-WINCH` (winch).

### `GET /api/config` — the whole configuration

### `PUT /api/config` — change it

The body is a **patch**, deep-merged into the stored configuration; the answer is the complete new configuration.

- Objects merge key by key.
- Arrays of objects merge element by element (`{"ports":[{}, {"universe":7}]}` changes only port 2).
- Arrays of plain values (`record.universes`) are replaced.
- The device validates and clamps values to their range, stores the result in non-volatile memory (NVS) and applies it
  without a reboot. A change of `net` is applied after the answer has been sent.

Common to every type:

| Field | Type | Meaning |
|---|---|---|
| `name` | string ≤ 32 | Shown in the manager |
| `net.dhcp` | bool | With DHCP on, the static fields are the fallback after 10 s without a lease |
| `net.ip`, `net.mask`, `net.gateway` | dotted string | Static address |
| `identify` | bool | Status LED / output blinks so the device can be found |

**edmx** — `ports[]`, one entry per DMX port:

| Field | Values | Meaning |
|---|---|---|
| `enabled` | bool | |
| `dir` | `out` · `in` | Network → DMX, or DMX → network |
| `protocol` | `artnet` · `sacn` | |
| `universe` | 0–63999 | Art-Net 15-bit port-address or sACN universe |
| `merge` | `htp` · `ltp` | When two sources send the same universe |
| `rate` | 1–44 Hz | DMX refresh rate on the wire |
| `onLoss` | `hold` · `blackout` | After 2.5 s without data |
| `rdm` | bool | RDM on this port |

`reroute[]` is reserved (per-channel patch) and stays an empty array in version 1.

**pixel** — `protocol`, and `ports[]`:

| Field | Values | Meaning |
|---|---|---|
| `enabled` | bool | |
| `chip` | `WS2812B` `WS2811` `SK6812` `SK6812-RGBW` `APA102` `UCS2903` | |
| `order` | `GRB` `RGB` `BRG` `RBG` `GBR` `BGR` `GRBW` `RGBW` | |
| `pixels` | 0–4096 | |
| `group` | 1–64 | Physical pixels per controlled pixel |
| `universe`, `startChannel` | 0–63999, 1–512 | First universe and channel |
| `reverse` | bool | Data enters at the far end |
| `limit` | 1–100 % | Brightness ceiling (power budget) |
| `gamma` | 1.0–3.0 | |

A port needs `ceil(pixels / group) × channels-per-pixel` channels. Pixels are never split across universes: a
universe carries 510 channels of RGB (170 pixels) or 508 of RGBW (127 pixels), and the port continues on the next
universe number.

**winch**

| Field | Values | Meaning |
|---|---|---|
| `protocol`, `universe`, `address` | — , 0–63999, 1–511 | Position = two channels, coarse then fine (16 bit) |
| `travel.min`, `travel.max` | mm | DMX 0 → `min` (top), DMX 65535 → `max` |
| `speedMax` | mm/s | |
| `accel` | mm/s² | Used for both acceleration and braking |
| `invert` | bool | Swaps the two ends of the DMX range |
| `onLoss` | `hold` · `home` | After 2.5 s without data |
| `pixel.enabled`, `pixel.universe`, `pixel.pixels`, `pixel.chip` | | The lamp carried by the winch |

**hub**

| Field | Meaning |
|---|---|
| `record.protocol`, `record.universes[]` | What a recording captures |
| `presets[]` `{ id, name, seconds }` | Recorded shows; `seconds` is the length |
| `triggers[]` `{ input, preset }` | Contact input → preset to start (0 = nothing) |
| `onBoot` | Preset to start at power-up (0 = nothing) |

### `GET /api/status` — live state (the manager reads it once a second; keep it cheap)

Common: `id`, `uptime` (s), `tempC`, `vin` (V), `heap` (bytes free), `rebooting`, `net { ip, link, rssi }`,
`identify`, `alarms[] { code, text }`.

- **edmx** `ports[] { enabled, universe, fps, level, test }` — `fps` = frames received in the last second, `level` = mean channel level 0–100.
- **pixel** `ports[] { enabled, universe, universes, pixels, fps, level, amps, test }`.
- **winch** `position`, `target` (mm), `speed` (mm/s, signed), `moving`, `homed`, `load` (%), `dmx { fps, level }`, `pixel { fps, level } | null`.
- **hub** `playback { state: idle|play|record, preset, t }`, `storage { used, total }` (bytes), `rx[] { universe, fps, level }`.

Alarm codes in version 1: `overtemp` (over 75 °C), `undervolt` (supply under 20 V), `nodata` (an enabled output
receives nothing), `stall` (winch motor). `text` is English and ready to show. A manager shows codes it does not
know by their `text`, so firmware may add codes.

### `POST /api/action` — commands

Body `{ "action": "<name>", … }`; answer `{ "ok": true }`, or 400 with `{ "ok": false, "error": … }` when the
device type does not support the action.

| Action | Parameters | Devices | Effect |
|---|---|---|---|
| `identify` | `on` (bool) | all | Same as `config.identify` |
| `reboot` | — | all | Answer first, restart after 200 ms |
| `factory` | `keepName` (default true) | all | Defaults, but the network settings (and the name) are kept |
| `test` | `port` (0-based), `pattern` | edmx, pixel | `off` `red` `green` `blue` `white` `chase` `rainbow`; overrides network data on that port until `off` or reboot |
| `home` | — | winch | Run to the top reference and set position 0; manual control until `release` |
| `jog` | `dir` −1 · 0 · 1 | winch | Move while held at 40 % of `speedMax`; the manager repeats nothing, so stop on `dir: 0` **and** after 1 s without a new jog |
| `goto` | `position` (mm) | winch | Manual target; DMX is ignored |
| `stop` | — | winch, hub | Stop where it is / stop playback or recording |
| `release` | — | winch | Leave manual control, follow DMX again |
| `play`, `record` | `preset` (id) | hub | |
| `fault` | `kind` | virtual only | Simulation aid; real firmware answers 400 |

## 4. Behaviour the manager relies on

1. `id` is stable and unique; `name` may repeat.
2. `/api/status` answers within 800 ms. Three missed polls mark the device offline; when it answers again the manager re-reads `/api/info` and `/api/config`.
3. `PUT /api/config` answers with the configuration the device actually stored (after clamping), so the manager never shows a value the device did not accept.
4. Manual winch control always wins over DMX until `release`.
5. Motion safety is the firmware's job, never the manager's: travel limits, the stall detector and the jog time-out must work with the network unplugged.

## 5. ESP32 implementation notes

- ESP-IDF: `esp_http_server` for the API, one lwIP UDP socket for discovery, cJSON for the bodies. Keep the
  configuration as one JSON blob in NVS plus a version number; apply the same merge as `merge()` in `vdevice.js`.
- Wired nodes: an Ethernet PHY (LAN8720 / RTL8201 on the RMII pins) or a W5500 over SPI. Wi-Fi is fine for
  configuration, but Art-Net at 40 Hz over many universes wants a cable.
- DMX out: a UART at 250 kbit/s 8N2 with the break generated by a baud-rate switch or `uart_set_line_inverse`; one
  RS-485 transceiver per port, isolated on the DMX side.
- Pixels: the RMT peripheral (or I2S / LCD parallel mode for eight ports) for WS281x timing; APA102 on SPI.
- Winch: a step/dir driver from MCPWM or RMT with a trapezoid ramp (`speedMax`, `accel`), a top limit switch for
  `home`, and the position kept in steps, converted with a steps-per-millimetre constant of the drum.
- Run the motion loop and the pixel output on the second core, away from the Wi-Fi / TCP task.
