# Changelog for homebridge-milighthub-platform

This is the change log for the plugin, all relevant changes will be listed here.

For documentation please see the [README](https://github.com/normen/homebridge-milighthub-platform/blob/master/README.md)

## 0.4.9

- fix logging regression

## 0.4.8

- improve MQTT initialization
- give hints about MQTT topic patterns
- README updates

## 0.4.7

- unify MQTT and HTTP message decoding
- README updates

## 0.4.6

- fix MQTT backchannel

## 0.4.5

- all devices need a re-initialization

## 0.4.4

- Fix HTTP backchannel
- Code cleanups

## 0.4.3

- Remove getters to avoid homebridge block altogether

## 0.4.2

- Changed backchannel updating to updateValue instead of using getters (#7)
- Added displayName to logging
- Updated dependencies

## 0.4.1

- Fixed light flashing when night mode is activated (#6)

## 0.4.0

- Use unique mqtt id
- Added darkMode

## 0.3.5

- Avoid sending hue when setting to white

## 0.3.4

- Small fixes

## 0.3.0

- All planned features implemented (thanks Zer0x00!)

## 0.2.0

- Fix update order by caching sequential homekit commands

## 0.1.1

- Cleanup hue/sat logic
- Make night mode work
