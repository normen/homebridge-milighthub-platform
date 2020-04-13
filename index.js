'use strict';
const packageJSON = require('./package.json');

var http = require('http');
var mqtt = require('mqtt');
var fs   = require('fs');
var path = require('path');

var Accessory, Service, Characteristic, UUIDGen;


module.exports = function (homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform('homebridge-milighthub-platform', 'MiLightHubPlatform', MiLightHubPlatform, true);
};

// config may be null
// api may be null if launched from old homebridge version
class MiLightHubPlatform {
  constructor (log, config, api) {
    if (!config) return;
    var platform = this;
    this.log = log;
    this.config = config;
    this.backchannel = config.backchannel || false;
    this.forceHTTP = config.forceHTTP || false;
    this.debug = config.debug || false;

    // according to https://github.com/apple/HomeKitADK/blob/master/HAP/HAPCharacteristicTypes.h this is a unsupported combination:
    // "This characteristic must not be used for lamps which support color."
    // but let the user choose because the RGB+CCT lamps do have seperate LEDs for the white temperatures and seperate for the RGB colors
    // controlling them in RGB mode lets seem the RGB screen to be buggy (orange colors will sometimes change to white_mode)
    // controlling them in RGB+CCT mode lets the color saving / favorite function to malfunction
    this.rgbcctMode = config.rgbcctMode === null ? false : this.rgbcctMode = config.rgbcctMode !== false;

    this.rgbRemotes = ['rgbw', 'cct', 'fut091'];
    this.rgbcctRemotes = ['fut089', 'cct', 'rgb_cct'];

    this.cachedPromises = [];

    // TODO: settings
    this.host = config.host || 'milight-hub.local';
    this.accessories = [];

    if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api;

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function () {
        platform.debugLog('DidFinishLaunching');
        platform.getServerLightList();
      });
    }
  }

  // Function invoked when homebridge tries to restore cached accessory.
  configureAccessory (accessory) {
    if (!this.config) { // happens if plugin is disabled and still active accessories
      return;
    }
    this.log('Restoring ' + accessory.displayName + ' from Homekit');
    accessory.reachable = true;
    this.accessories.push(new MiLight(this, accessory));
  }

  // Handler will be invoked when user try to config your plugin.
  // Callback can be cached and invoke when necessary.
  configurationRequestHandler (context, request, callback) {
    callback(null);
  }

  debugLog (message) {
    if (!this.debug) {
      return;
    }

    const debugLogDelimiter = 'DEBUG: ';
    if (Array.isArray(message)) {
      for (var i = 0, len = message.length; i < len; i++) {
        if (i === 0) {
          this.log(debugLogDelimiter, message[i]);
        } else {
          console.log(message[i])
        }
      }
    } else {
      this.log(debugLogDelimiter, message);
    }
  }

  getServerLightList () {
    const platform = this;
    const settings_path = '/settings';

    this.debugLog('Querying ' + settings_path);
    this.apiCall(settings_path).then(response => {
      if (response) {
        var lightList = [];
        const settings = JSON.parse(response);
        if (platform.mqttServer !== settings.mqtt_server) {
          platform.mqttServer = settings.mqtt_server;
          platform.mqttUser = settings.mqtt_username;
          platform.mqttPass = settings.mqtt_password;
          platform.mqttTopicPattern = settings.mqtt_topic_pattern;
          if (platform.mqttClient) {
            platform.mqttClient.end();
            platform.mqttClient = null;
          }
          // TODO: user / pass
          if (platform.mqttServer && !(platform.forceHTTP)) {
            platform.log('Using MQTT server at ' + platform.mqttServer);
            platform.mqttClient = mqtt.connect('mqtt://' + platform.mqttServer);
          } else {
            platform.log('Using HTTP server at ' + platform.host);
          }
        }
        for (var name in settings.group_id_aliases) {
          var values = settings.group_id_aliases[name];
          var lightInfo = { name: name, device_id: values[1], group_id: values[2], remote_type: values[0] };
          lightList.push(lightInfo);
        }

        platform.syncLightLists(lightList);
      } else {

      }
      setTimeout(platform.getServerLightList.bind(platform), 10000);
    });
  }

  syncLightLists (lightList) {
    const platform = this;

    // Remove light from HomeKit
    this.accessories.forEach((milight, idx) => {
      var found = false;
      var characteristicsMatch = true;
      lightList.forEach(lightInfo => {
        if (milight.group_id === lightInfo.group_id &&
            milight.device_id === lightInfo.device_id &&
            milight.remote_type === lightInfo.remote_type &&
            milight.name === lightInfo.name) {
          // already exists
          found = true;
        }
      });

      var characteristicsCacheDirPath = path.join(__dirname , 'cache', '0x' + milight.device_id.toString(16), milight.remote_type.toString());
      var characteristicsCacheFilePath = path.join(characteristicsCacheDirPath , milight.group_id.toString() + '_characteristics.log');

      if(found){
        if (fs.existsSync(characteristicsCacheFilePath)){
          const HAPOnCharacteristic = '00000025-0000-1000-8000-0026BB765291'; // 00000025-0000-1000-8000-0026BB765291 = 'On' - Use the power characteristic to determine if backchannel was enabled in lastState
          const HAPColorTemperatureCharacteristic = '000000CE-0000-1000-8000-0026BB765291'; // 00000025-0000-1000-8000-0026BB765291 = 'ColorTemperature' - Use the ColorTemperature characteristic to determine if rgbcctMode is applied correctly

          var cachedData = JSON.parse(fs.readFileSync(characteristicsCacheFilePath));
          var cachedDateEventsCount = parseInt(cachedData[HAPOnCharacteristic]['_eventsCount']);
          var miLightCharacteristics = JSON.parse(milight.characteristics);
          var miLightCharacteristicsEventsCount = parseInt(miLightCharacteristics[HAPOnCharacteristic]['_eventsCount']);

          // check if backchannel matches with set state
          if(cachedDateEventsCount !== miLightCharacteristicsEventsCount){
            this.debugLog('Backchannel characteristics mismatch detected, Removing accessory!');
            characteristicsMatch = false;
          }

          // check if rgbcctMode matches with set state
          if (platform.rgbcctRemotes.indexOf(milight.remote_type) > -1 && ((platform.rgbcctMode && !cachedData[HAPColorTemperatureCharacteristic]) || (!platform.rgbcctMode && cachedData[HAPColorTemperatureCharacteristic]))) {
            this.debugLog('ColorTemperature Characteristics mismatch detected, Removing accessory!');
            characteristicsMatch = false;
          }
        } else {
          characteristicsMatch = false;
        }
      }

      if (!found || !characteristicsMatch) {
        this.log('Removing ' + milight.name + ' from Homekit');
        this.accessories.splice(idx, 1);

        if (fs.existsSync(characteristicsCacheFilePath)){
          fs.unlinkSync(characteristicsCacheFilePath);
        }

        this.api.unregisterPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });

    // Add light to HomeKit
    lightList.forEach(lightInfo => {
      var found = false;
      this.accessories.forEach(milight => {
        if (milight.group_id === lightInfo.group_id &&
            milight.device_id === lightInfo.device_id &&
            milight.remote_type === lightInfo.remote_type &&
            milight.name === lightInfo.name) {
          found = true;
        }
      });

      if (!found) {
        this.log('Adding ' + lightInfo.name + ' to Homekit');
        const milight = new MiLight(platform, lightInfo);
        this.accessories.push(milight);

        var characteristicsCacheDirPath = path.join(__dirname , 'cache', '0x' + milight.device_id.toString(16), milight.remote_type.toString());
        var characteristicsCacheFilePath = path.join(characteristicsCacheDirPath , milight.group_id.toString() + '_characteristics.log');

        if (!fs.existsSync(characteristicsCacheDirPath)){
          fs.mkdirSync(characteristicsCacheDirPath, { recursive: true });
        }

        fs.writeFileSync(characteristicsCacheFilePath, milight.characteristics);
        platform.debugLog('Created ' + characteristicsCacheFilePath + ' with characteristics');

        this.api.registerPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });
  }


  sendCommand (deviceId, remoteType, groupId, command) {
    if (this.mqttClient) {
      var path = this.mqttTopicPattern.replace(':device_id', deviceId).replace(':device_type', remoteType).replace(':group_id', groupId);
      const sendBody = JSON.stringify(command);
      try {
        this.mqttClient.publish(path, sendBody);
        this.log(path, command);
      } catch (e) {
        this.log(e);
      }
      return true;
    } else {
      var path = '/gateways/' + '0x' + deviceId.toString(16) + '/' + remoteType + '/' + groupId;
      this.log('SENT: ' + path, command);
      this.apiCall(path, command);
    }
  }

  async apiCall (path, json = null, func) {
    // MiLight Hub lets you know all properties of the device on one HTTP request.
    // Unfortunately HomeKit queries each characteristic separately, so we've build a dedup function
    // It looks if the current job is already in Promise state 'PENDING' (running)
    // If yes return the same promise from cache --> don't start a new one(!)
    // If no start a promise, cache it and return this
    if (this.cachedPromises[path] === 'PENDING'){
      this.debugLog('GET (dedup): ' + path);
      return await this.cachedPromises[path + '_promise'];
    } else {
      this.debugLog('GET: ' + path);
      if(path !== '/settings' && json === null){
        this.cachedPromises[path] = 'PENDING';
      }

      this.cachedPromises[path + '_promise'] = new Promise(resolve => {
        const url = 'http://' + this.host + path;

        var http_header;
        if(json === null){
          http_header ={
            method: 'GET'
          };
        } else {
          var sendBody = JSON.stringify(json);
          http_header ={
            method: 'PUT',
            headers: {
              'Content-Length': sendBody.length
            }
          };
        }

        const req = http.request(url, http_header, res => {
          let recvBody = '';
          res.on('data', chunk => {
            recvBody += chunk;
          });
          res.on('end', _ => {
            // this.debugLog(['\n', 'GET request end - HTTP status code: ' + res.statusCode + '\nrecvBody: ', JSON.parse(recvBody)]);
            if (res.statusCode === 200) {
              resolve(recvBody);
            } else {
              resolve(false);
            }
            this.cachedPromises[path] = 'new run';
          });
        });
        req.on('error', e => {
          if(json === null){
            console.log('Error sending to MiLight ESP hub', url, json, e);
          } else {
            console.log('Error sending to MiLight ESP hub', url, e);
          }
          resolve(false);
          this.cachedPromises[path] = 'new run';
        });
        if(json !== null){
          req.write(sendBody);
        }
        req.end();
      });

      return this.cachedPromises[path + "_promise"];
    }


  }

  //RGBtoHSV by Garry Tan from https://axonflux.com/handy-rgb-to-hsl-and-rgb-to-hsv-color-model-c with some modifications
  RGBtoHS(r, g, b) {
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b),
        a = max - min;

    switch(max) {
      case min:
        var h = 0;
        break;
      case r:
        h = (g - b + a * (g < b ? 6 : 0)) / (6 * a);
        break;
      case g:
        h = (b - r + 2 * a) / (6 * a);
        break;
      case b:
        h = (r - g + 4 * a) / (6 * a);
    }

    return {
      h: Math.round(100 * h),
      s: Math.round(100 * (0 === max ? 0 : a / max))
    };
  }


}

class MiLight {
  constructor (platform, accessory) {
    this.platform = platform;
    if (accessory instanceof Accessory) {
      this.accessory = accessory;
    } else {
      // new accessory object
      var uuid = UUIDGen.generate(accessory.name);
      this.platform.log('Creating new accessory for ' + accessory.name + ' [' + uuid + ']');
      this.accessory = new Accessory(accessory.name, uuid);
      this.accessory.context.light_info = accessory;
      this.addServices(this.accessory);
    }
    // read context info
    this.name = this.accessory.context.light_info.name;
    this.device_id = this.accessory.context.light_info.device_id;
    this.group_id = this.accessory.context.light_info.group_id;
    this.remote_type = this.accessory.context.light_info.remote_type;
    this.applyCallbacks(this.accessory);
    this.currentState = { state: false, level: 100, saturation: 0, hue: 0, color_temp: 0 };
    this.designatedState = {};
    this.characteristics = {};

    for (let services of this.accessory.services) {
      var service = JSON.parse(JSON.stringify(services));

      for (let characteristic of service.characteristics){
        this.characteristics[characteristic.UUID] = characteristic;
      }
    }

    this.characteristics = JSON.stringify(this.characteristics);

    this.myTimeout = null;
  }

  addServices (accessory) {
    const informationService = accessory.getService(Service.AccessoryInformation);// new Service.AccessoryInformation();
    if (informationService) {
      informationService
          .setCharacteristic(Characteristic.Manufacturer, 'MiLight')
          .setCharacteristic(Characteristic.Model, (accessory.context.light_info.remote_type).toUpperCase())
          .setCharacteristic(Characteristic.SerialNumber, accessory.context.light_info.device_id + '[' + accessory.context.light_info.group_id + ']')
          .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);
    } else {
      this.log('Error: No information service found');
    }

    const lightbulbService = new Service.Lightbulb(this.name);
    lightbulbService.addCharacteristic(new Characteristic.Brightness());

    if (this.platform.rgbRemotes.indexOf(this.remote_type) === -1) {
      lightbulbService.addCharacteristic(new Characteristic.Saturation());
      lightbulbService.addCharacteristic(new Characteristic.Hue());
    }

    if (this.platform.rgbcctMode && this.platform.rgbcctRemotes.indexOf(this.remote_type) > -1) {
      lightbulbService
          .addCharacteristic(new Characteristic.ColorTemperature())
          // maxValue 370 = 2700K (1000000/2700)
          // minValue 153 = 6500K (1000000/6500)
          .setProps({
            maxValue: 370,
            minValue: 153
          });
    }
    accessory.addService(lightbulbService);
  }

  applyCallbacks (accessory) {
    const lightbulbService = accessory.getService(Service.Lightbulb);

    if (!lightbulbService) {
      this.log('Error: unconfigured accessory without light service found.');
      return;
    }

    if (lightbulbService.getCharacteristic(Characteristic.On)) {
      this.platform.debugLog('Characteristic.On is set');

      if(this.platform.backchannel) {
        lightbulbService.getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this));
      }
      lightbulbService.getCharacteristic(Characteristic.On)
          .on('set', this.setPowerState.bind(this));
    }

    if (lightbulbService.getCharacteristic(Characteristic.Brightness)) {
      this.platform.debugLog('Characteristic.Brightness is set');

      if(this.platform.backchannel) {
        lightbulbService.getCharacteristic(Characteristic.Brightness)
            .on('get', this.getBrightness.bind(this));
      }
      lightbulbService.getCharacteristic(Characteristic.Brightness)
          .on('set', this.setBrightness.bind(this));
    }

    if (lightbulbService.getCharacteristic(Characteristic.Hue)) {
      this.platform.debugLog('Characteristic.Hue is set');

      if(this.platform.backchannel) {
        lightbulbService.getCharacteristic(Characteristic.Hue)
            .on('get', this.getHue.bind(this));
      }
      lightbulbService.getCharacteristic(Characteristic.Hue)
          .on('set', this.setHue.bind(this));
    }

    if (lightbulbService.getCharacteristic(Characteristic.Saturation)) {
      this.platform.debugLog('Characteristic.Saturation is set');

      if(this.platform.backchannel) {
        lightbulbService.getCharacteristic(Characteristic.Saturation)
            .on('get', this.getSaturation.bind(this));
      }
      lightbulbService.getCharacteristic(Characteristic.Saturation)
          .on('set', this.setSaturation.bind(this));
    }


    if(this.platform.rgbcctMode && (lightbulbService.getCharacteristic(Characteristic.ColorTemperature))) {
      this.platform.debugLog('Characteristic.ColorTemperature is set');

      if(this.platform.backchannel) {
        lightbulbService.getCharacteristic(Characteristic.ColorTemperature)
            .on('get', this.getColorTemperature.bind(this));
      }
      lightbulbService.getCharacteristic(Characteristic.ColorTemperature)
          .on('set', this.setColorTemperature.bind(this));

    }

  }

  stateChange () {
    if (this.myTimeout) {
      clearTimeout(this.myTimeout);
    }
    this.myTimeout = setTimeout(this.applyDesignatedState.bind(this), 100);
  }

  testWhiteMode(hue, saturation){ // Copyright goes to https://gitlab.com/jespertheend/homebridge-milight-esp/-/blob/master/index.js
    if(hue < 150){
      let fn1 = -70 / (hue - 30) + 2.5;
      let fn2 = -70 / (hue - 33) + 1;
      return (saturation < fn1 || hue >= 30) && (saturation > fn2 && hue < 33);
    }else{
      let fn3 = 70 / (hue - 219) + 2.7;
      let fn4 = 90 / (hue - 216) + 0.8;
      return saturation < fn3 && saturation > fn4;
    }
  }

  applyDesignatedState () {
    // this.myTimeout = null;
    const dstate = this.designatedState;
    const cstate = this.currentState;
    this.designatedState = {};
    const command = {};

    if (dstate.state) {
      if (dstate.level === undefined) {
        dstate.level = cstate.level;
      }
      if (dstate.level > 1) {
        command.state = 'On';
        command.level = dstate.level;
        cstate.level = dstate.level;
      } else if (dstate.level <= 1) {
        command.commands = ['night_mode'];
        cstate.level = dstate.level;
      }
      cstate.state = dstate.state;
    } else if (dstate.state !== undefined) {
      command.state = 'Off';
      cstate.state = dstate.state;
    }
    if (dstate.saturation !== undefined) {
      if (dstate.saturation === 0) {
        if (command.commands) {
          command.commands = command.commands.concat(['set_white']);
        } else {
          command.commands = ['set_white'];
        }
      } else {
        command.saturation = dstate.saturation;
      }
      cstate.saturation = dstate.saturation;
    }
    if (dstate.hue !== undefined) {
      command.hue = dstate.hue;
      cstate.hue = dstate.hue;
    }

    if(!this.platform.rgbcctMode){
      let useWhiteMode = this.testWhiteMode(dstate.hue, dstate.saturation);
      if(useWhiteMode){
        delete command.saturation;
        delete command.hue;
        let kelvin = 100;
        if(dstate.hue > 150){
          kelvin = 0.5 - dstate.saturation / 40;
        }else{
          kelvin = Math.sqrt(dstate.saturation*0.0033) + 0.5;
          kelvin = Math.min(1, Math.max(0, kelvin));
        }
        kelvin *= 100;
        kelvin = Math.round(kelvin);

        command.kelvin = kelvin;
        cstate.kelvin = kelvin;
      }
    } else if (dstate.color_temp !== undefined) {
      command.color_temp = dstate.color_temp;
      cstate.color_temp = dstate.color_temp;
    }

    this.platform.sendCommand(this.device_id, this.remote_type, this.group_id, command);
  }

  /** MiLight shiz */
  async getPowerState (callback) {
    if (this.platform.mqttClient) {
      // TODO: implement getPowerState via MQTT
      //not implemented yet so return null
      callback(null, null);
    } else {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;

      this.platform.debugLog(['[getPowerState] GET Request']);
      var returnValue = JSON.parse(await this.platform.apiCall(path));

      callback(null, returnValue.state === 'ON' || returnValue.bulb_mode === 'night');
    }
  }

  setPowerState (powerOn, callback) {
    this.designatedState.state = powerOn;

    this.platform.debugLog(['[setPowerState] ' + powerOn]);

    this.stateChange();
    callback(null);
  }

  async getBrightness (callback) {
    var brightness;

    if (this.platform.mqttClient) {
      // TODO: implement getBrightness via MQTT
      // not implemented yet so return null
      callback(null, null);
    } else {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;

      this.platform.debugLog(['[getBrightness] GET Request']);
      var returnValue = JSON.parse(await this.platform.apiCall(path));

      if(returnValue.bulb_mode === 'night'){
        brightness = 1; //set brightness to 1 if night_mode is enabled
      } else {
        brightness = Math.round(returnValue.brightness/2.55); //rounding should not be necessary but implemented it to be safe
      }

      callback(null, brightness);
    }
  }

  setBrightness (level, callback) {
    this.designatedState.level = level;

    this.platform.debugLog(['[setBrightness] ' + level]);

    this.stateChange();
    callback(null);
  }

  async getHue (callback) {
    if (this.platform.mqttClient) {
      // TODO: implement getHue via MQTT
      //not implemented yet so return null
      callback(null, null);
    } else {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;

      this.platform.debugLog(['[getHue] GET Request']);
      var returnValue = JSON.parse(await this.platform.apiCall(path));

      if(returnValue.bulb_mode === "color"){
        var calculatedHS = this.platform.RGBtoHS(returnValue.color.r, returnValue.color.g, returnValue.color.b);
        callback(null, calculatedHS.h);
      } else {
        callback(null, null);
      }
    }
  }

  setHue (value, callback) {
    this.designatedState.hue = value;

    this.platform.debugLog(['[setHue] ' + value]);

    this.stateChange();
    callback(null);
  }

  async getSaturation (callback) {
    if (this.platform.mqttClient) {
      // TODO: implement getSaturation via MQTT
      //not implemented yet so return null
      callback(null, null);
    } else {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;

      this.platform.debugLog(['[getSaturation] GET Request']);
      var returnValue = JSON.parse(await this.platform.apiCall(path));

      if(returnValue.bulb_mode === "color"){
        var calculatedHS = this.platform.RGBtoHS(returnValue.color.r, returnValue.color.g, returnValue.color.b);
        callback(null, calculatedHS.s);
      } else {
        callback(null, null);
      }
    }
  }

  setSaturation (value, callback) {
    this.designatedState.saturation = value;

    this.platform.debugLog(['[setSaturation] ' + value]);

    this.stateChange();
    callback(null);
  }

  async getColorTemperature (callback) {
    if (this.platform.mqttClient) {
      // TODO: implement getBrightness via MQTT
      // not implemented yet so return null
      callback(null, null);
    } else {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;

      this.platform.debugLog(['[getColorTemperature] GET Request']);
      var returnValue = JSON.parse(await this.platform.apiCall(path));

      if(returnValue.bulb_mode === "color"){
        callback(null, null);
      } else {
        var colorTemperature = Math.round(100000 / returnValue.color_temp); //rounding should not be necessary but implemented it to be safe
        callback(null, colorTemperature);
      }
    }
  }

  setColorTemperature (value, callback) {
    this.designatedState.color_temp = value;

    this.platform.debugLog(['[setColorTemperature] ' + value]);

    this.stateChange();
    callback(null);
  }
}