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
- Currently only RGB(W) lamps have been confirmed to work, others *might* work as well

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

## Usage
#### Adding/removing Lamps
To add lamps in HomeKit, add aliases to the MiLight Hub. The aliases will automatically appear as lamps in HomeKit. If you remove an alias on the MiLight Hub the corresponding lamp will be removed as well.

#### Using MQTT
If MQTT is configured in the MiLight Hub then the plugin will automatically read those settings and use them to connect to MiLight Hub via MQTT. Make sure your MQTT topic pattern includes the `:device_id`, `:device_type` and `:group_id` values, as in the suggested default value `milight/:device_id/:device_type/:group_id`.