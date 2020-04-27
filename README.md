# homebridge-milighthub-platform [![NPM Version](https://img.shields.io/npm/v/homebridge-milighthub-platform.svg)](https://www.npmjs.com/package/homebridge-milighthub-platform)
Homebridge plugin to control MiLight / EULight lamps through the Open Source [MiLight Hub](https://github.com/sidoh/esp8266_milight_hub).

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
```
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
 - `backchannel` Enables/Disables backchannel, currently limited to http only, default `false` (disabled)
 - `rgbcctMode` Enables ColorTemperature characteristic which is unsupported by HomeKit in combination with RGB characteristics but gives you a more accurate control of your lights at the expense of not supporting favourite colors in Home App anymore, default `false` (disabled)
 --- further explanation at the bottom 
 - `httpUsername` If you are using a username:password authentication for your MiLight Hub type in here your credentials, default `null` (disabled)
 - `httpPassword` If you are using a username:password authentication for your MiLight Hub type in here your credentials, default `null` (disabled)
 - `forceHTTP` Force use of HTTP regardless of MQTT settings in your MiLight hub, default `false` (disabled)
 - `syncHubInterval` Defines the interval in seconds when the plugin synchronizes with the hub, default every `10` seconds
 - `commandDelay` Define the delay to send the commands with in milliseconds, default `100` milliseconds
 - `debug` Enables/Disables debug mode, default `false` (disabled)

## Usage
#### Adding/removing Lamps
To add lamps in HomeKit, add aliases to the MiLight Hub. The aliases will automatically appear as lamps in HomeKit. If you remove an alias on the MiLight Hub the corresponding lamp will be removed as well.

#### Using MQTT
If MQTT is configured in the MiLight Hub then the plugin will automatically read those settings and use them to connect to MiLight Hub via MQTT. Make sure your MQTT topic pattern includes the `:device_id`, `:device_type` and `:group_id` values, as in the suggested default value `milight/:device_id/:device_type/:group_id`.

## Limitation
#### RGB+CCT / RGBW(W) lamps
RGB+CCT / RGBW(W) milights have two modes, color tempurature and RGB. Unfurtunately HomeKit does not support lights with both modes active at the same time, so it's not supported to expose both RGB and Kelvin properties to Homekit. The default mode exposes only an RGB property, but detects when you set a color that is close to the colors used in the tempurature circle in HomeKit and uses the color tempurature mode on the milights in this case. This way you can still make use of favourite light-settings in the Home app. If you want to expose both properties anyway you can enable the RGB+CCT mode.
