# homebridge-milighthub-platform [![NPM Version](https://img.shields.io/npm/v/homebridge-milighthub-platform.svg)](https://www.npmjs.com/package/homebridge-milighthub-platform)
Homebridge plugin to control MiLight / EULight lamps through the Open Source [MiLight Hub](https://github.com/sidoh/esp8266_milight_hub).

This plugin is a WIP, check below for the current limitations.

## Features
- Automatically fetches all MiLight Hub aliases as lights
  - Add/Remove lamps through the MiLight Hub web interface
  - No config.json editing, no entering stuff twice
- Automatically uses MQTT if configured in the MiLight Hub
  - Using an MQTT broker can improve performance when using many lamps

## WIP
- Currently no password support for MiLight Hub or MQTT server
- Currently only RGB(W) + RGB+CCT lamps have been confirmed to work, others *might* work as well
- Currently no backchannel for mqtt, HomeKit doesn't update if MiLight hub is controlled otherwise
- Some options like backchannel, rgbcctMode need a manual re-add of accessories before being active. 
If you don't do a re-add they may behave weird or the application may crash.
Re-adding is done as follows: Go to your Milight Hub, select an alias and remove it.
Wait until you see that the accessory was deleted in the homebridge logs.
After that add it again. Repeat above steps for every alias.

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
 - `forceHTTP` Force use of HTTP regardless of MQTT settings in your MiLight hub, default `false` (disabled)
 - `debug` Enables/Disables debug mode, default `false` (disabled)

## Usage
#### Adding/removing Lamps
To add lamps in HomeKit, add aliases to the MiLight Hub. The aliases will automatically appear as lamps in HomeKit. If you remove an alias on the MiLight Hub the corresponding lamp will be removed as well.

#### Using MQTT
If MQTT is configured in the MiLight Hub then the plugin will automatically read those settings and use them to connect to MiLight Hub via MQTT. Make sure your MQTT topic pattern includes the `:device_id`, `:device_type` and `:group_id` values, as in the suggested default value `milight/:device_id/:device_type/:group_id`.


## Limitation
#### RGB+CCT lamps
RGB+CCT (or RGBWW) milights have two modes, color tempurature or RGB. Unfurtunately HomeKit does not support lights with both modes, so it's not supported to expose both RGB and Kelvin properties to Homekit. The default mode exposes only an RGB property, but detects when you set a color that is close to the colors used in the tempurature circle in HomeKit and uses the color tempurature mode on the milights in this case. This way you can still make use of favourite light-settings in the Home app. If you want to expose both properties anyway you can enable the RGB+CCT mode.
