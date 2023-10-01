# homebridge-milighthub-platform [![NPM Version](https://img.shields.io/npm/v/homebridge-milighthub-platform.svg)](https://www.npmjs.com/package/homebridge-milighthub-platform) [![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homebridge plugin to control MiLight / LightEU / Limitless / Easybulb lamps through the ESP8266 based Open Source [MiLight Hub](https://github.com/sidoh/esp8266_milight_hub).

## Features

- Automatically fetches all MiLight Hub aliases as lights
  - Add/Remove lamps through the MiLight Hub web interface
  - No config.json editing, no entering stuff twice
- Automatically uses MQTT if configured in the MiLight Hub
  - Using an MQTT broker can improve performance when using many lamps

## Installation

1. Install homebridge using: npm install -g homebridge
2. Install this plugin using: npm install -g homebridge-milighthub-platform
3. Add the plugin through your config.json

#### Example config

```json
{
  "bridge": {
    "name": "Homebridge",
    "username": "CC:22:3D:E3:CE:30",
    "port": 51826,
    "pin": "031-45-154"
  },
  "platforms": [
    {
      "platform": "MiLightHubPlatform"
    }
  ]
}
```

#### Options

- `host` Hostname of your MiLight Hub, default `milight-hub.local`
- `name` The name of the platform as it appears in the homebridge log, default `MiLightHubPlatform`
- `httpUsername` If you are using a username:password authentication for your MiLight Hub type in here your credentials, default `null` (disabled)
- `httpPassword` If you are using a username:password authentication for your MiLight Hub type in here your credentials, default `null` (disabled)
- `backchannel` Enables/Disables backchannel, default `false` (disabled)
- `darkMode` Enables/Disables setting a low brightness value to mitigate the bright flashing of the lights if you turn them on with a low brightness & caches the last value before power off, default `false` (disabled)
- `darkModeOnModeChange` Enables/Disables setting a low brightness value to mitigate the bright flashing of the lights if you change between color mode and white mode, default `false` (disabled)
- `rgbcctMode` Enables ColorTemperature characteristic which is unsupported by HomeKit in combination with RGB characteristics but gives you a more accurate control of your lights at the expense of not supporting favourite colors in Home App anymore, default `false` (disabled)
- `forceHTTP` Force use of HTTP regardless of MQTT settings in your MiLight hub, default `false` (disabled)
- `syncHubInterval` Defines the interval in seconds when the plugin synchronizes with the hub, default every `10` seconds
- `commandDelay` Defines the delay to send the commands with in milliseconds, default `100` milliseconds
- `debug` Enables/Disables debug mode, default `false` (disabled)

## Usage

#### Adding/removing Lamps

To add lamps in HomeKit, add aliases to the MiLight Hub. The aliases will automatically appear as lamps in HomeKit. If you remove an alias on the MiLight Hub the corresponding lamp will be removed as well.

#### Using MQTT

If MQTT is configured in the MiLight Hub then the plugin will automatically read those settings and use them to connect to MiLight Hub via MQTT.

Make sure your MQTT _topic pattern_ includes the `:device_id`, `:device_type` and `:group_id` values, e.g. `milight/:device_id/:device_type/:group_id`.

To use the MQTT backchannel set MQTT topic _state pattern_ to e.g. `milight_state/:device_id/:device_type/:group_id`.

## Limitations

#### darkMode flag

This option changes 2 things:
1st: It sets the brightness value to 1 when switching off, so that when switching on again the lights do not flash super bright for a short moment.
2nd thing: It saves the last brightness value before the lights are switched off, so that when they are switched on again, they have the same value as before.

Unfortunately, there's a flip side to the coin: programmatically there's no way to distinguish between switching the lights on by sliding the brightness slider to 100 and switching them on by clicking the lights button. Since the cached value overwrites your brightness setting to 100, this leads to the error that your brightness is not set to 100 and you have to repeat the process.

#### RGB+CCT / RGBW(W) lamps

RGB+CCT / RGBW(W) milights have two modes, color temperature and RGB. Unfortunately HomeKit does not support lights with both modes active at the same time, so it's not supported to expose both RGB and Kelvin properties to Homekit. The default mode exposes only an RGB property, but detects when you set a color that is close to the colors used in the temperature circle in HomeKit and uses the color temperature mode on the milights in this case. This way you can still make use of favourite light-settings in the Home app. If you want to expose both properties anyway you can enable the RGB+CCT mode.

## Development

If you want new features or improve the plugin, you're very welcome to do so. The projects `devDependencies` include homebridge and the `npm run test` command has been adapted so that you can run a test instance of homebridge during development.

#### Setup

- Clone github repo
- `npm install` in the project folder
- Create `.homebridge` folder in project root
- Add `config.json` with appropriate content to `.homebridge` folder
- Run `npm run test` to start the homebridge instance for testing
