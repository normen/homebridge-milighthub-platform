'use strict';
const packageJSON = require('./package.json');
var http = require('http');
var mqtt = require('mqtt');

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform('homebridge-milighthub-platform', 'MiLightHubPlatform', MiLightHubPlatform, true);
};

// main platform class, manages milight Accessories for one milight hub
class MiLightHubPlatform {
  constructor (log, config, api) {
    // config may be null
    // api may be null if launched from old homebridge version
    if (!config || !api) return;
    var platform = this;
    this.api = api;
    this.log = log;
    this.config = config;
    this.httpUsername = config.httpUsername || null;
    this.httpPassword = config.httpPassword || null;
    this.backchannel = config.backchannel || false;
    this.forceHTTP = config.forceHTTP || false;
    this.debug = config.debug || false;
    this.darkMode = config.darkMode || false;
    this.host = config.host || 'milight-hub.local';
    this.syncHubInterval = config.syncHubInterval || 10;
    this.commandDelay = config.commandDelay || 100;
    // according to https://github.com/apple/HomeKitADK/blob/master/HAP/HAPCharacteristicTypes.h this is a unsupported combination:
    // "This characteristic must not be used for lamps which support color."
    // but let the user choose because the RGB+CCT lamps do have seperate LEDs for the white temperatures and seperate for the RGB colors
    // controlling them in RGB mode lets seem the RGB screen to be buggy (orange colors will sometimes change to white_mode)
    // controlling them in RGB+CCT mode lets the color saving / favorite function to malfunction
    this.rgbcctMode = config.rgbcctMode === undefined ? false : this.rgbcctMode = config.rgbcctMode !== false;
    // TODO: remove in favor of accessory.context
    this.characteristicDetails = '0x2' + ',0x' + (this.rgbcctMode ? 1 : 0).toString();
    this.whiteRemotes = ['cct', 'fut091']; // only Cold white + Warm white remotes
    this.rgbRemotes = ['rgbw', 'rgb', 'fut020']; // only RGB remotes
    this.rgbcctRemotes = ['fut089', 'rgb_cct']; // RGB + Cold white + Warm white remotes
    this.cachedPromises = [];
    this.accessories = [];

    this.api.on('didFinishLaunching', function () {
      platform.debugLog('DidFinishLaunching');
      platform.getServerLightList();
    });
    if (this.httpUsername && this.httpPassword) {
      this.debugLog('Using Basic Authorization!');
    }
  }

  // Function invoked when homebridge tries to restore cached accessory.
  configureAccessory (accessory) {
    if (!this.config) { // happens if plugin is disabled and still active accessories
      return;
    }
    this.log('Restoring ' + accessory.displayName + ' from HomeKit');
    accessory.reachable = true;
    this.accessories.push(new MiLight(this, accessory));
  }

  // Handler will be invoked when user try to config your plugin.
  // Callback can be cached and invoke when necessary.
  configurationRequestHandler (context, request, callback) {
    callback(null);
  }

  // send debug log message in debug mode only
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
          this.log(message[i]);
        }
      }
    } else {
      this.log(debugLogDelimiter, message);
    }
  }

  // reads server light list and MQTT settings via HTTP
  // called recurringly, based on syncHubInterval
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
          platform.mqttStateTopicPattern = settings.mqtt_state_topic_pattern;
          if (platform.mqttClient) {
            platform.mqttClient.end();
            platform.mqttClient = null;
          }
          if (platform.mqttServer && !(platform.forceHTTP)) {
            if(platform.mqttTopicPattern == ""){
              platform.log("Cannot send MQTT commands, no MQTT topic pattern set in Milight Hub.");
              platform.log("Set topic pattern to 'milight/:device_id/:device_type/:group_id' in Milight Hub!");
              platform.log('Using HTTP server at ' + platform.host);
            } else {
              platform.log('Using MQTT server at ' + platform.mqttServer);
              platform.initializeMQTT();
            }
          } else {
            platform.log('Using HTTP server at ' + platform.host);
          }
        }
        for (var name in settings.group_id_aliases) {
          var values = settings.group_id_aliases[name];
          var lightInfo = { name: name, device_id: values[1], group_id: values[2], remote_type: values[0], uid: '0x' + values[1].toString(16).toUpperCase() + '/' + values[0] + '/' + values[2] };
          lightList.push(lightInfo);
        }
        platform.syncLightLists(lightList);
      }
      setTimeout(platform.getServerLightList.bind(platform), platform.syncHubInterval * 1000);
    });
  }

  // syncs the light list with the lights reported to HomeKit, i.e. the list of Milight instances
  // also updates single lights status via HTTP if no MQTT server is found
  syncLightLists (lightList) {
    const platform = this;
    // Remove light from HomeKit if it does not exist in MiLight Hub
    this.accessories.forEach((milight, idx) => {
      var found = false;
      var characteristicsMatch = true;
      if (lightList.find(lightInfo => (
        milight.group_id === lightInfo.group_id &&
          milight.device_id === lightInfo.device_id &&
          milight.remote_type === lightInfo.remote_type &&
          milight.name === lightInfo.name)) !== undefined) {
        found = true;
        // TODO: move "characteristicDetails" to accessory.context (object thats stored with homekits database)
        // See Milight constructor for current use, accessory.context.light_info contains the configuration for that light
        if (platform.characteristicDetails !== milight.accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Model).value) {
          this.debugLog('Characteristics mismatch detected, Removing accessory!');
          characteristicsMatch = false;
        } else if (this.backchannel && !platform.mqttClient) {
          // if we have a backchannel and use HTTP, send an update request
          // this will run the actual request asynchronously
          milight.getState();
        }
      }
      // remove light if it doesn't exist or has to be reloaded
      if (!found || !characteristicsMatch) {
        let removeMessage = 'Removing ' + milight.name + ' from HomeKit because ';
        if (!found) {
          removeMessage += 'it could not be found in MiLight Hub';
        } else {
          removeMessage += 'a characteristics mismatch was detected';
        }
        this.log(removeMessage);
        this.accessories.splice(idx, 1);
        this.api.unregisterPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });
    // Add new lights to HomeKit
    lightList.forEach(lightInfo => {
      if (this.accessories.find(milight => (
        milight.group_id === lightInfo.group_id &&
          milight.device_id === lightInfo.device_id &&
          milight.remote_type === lightInfo.remote_type &&
          milight.name === lightInfo.name)) === undefined) {
        this.log('Adding ' + lightInfo.name + ' to HomeKit');
        const milight = new MiLight(platform, lightInfo);
        this.accessories.push(milight);
        this.api.registerPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });
  }

  // send a command to MilightHub via either HTTP or MQTT
  sendCommand (name, deviceId, remoteType, groupId, command) {
    if (this.mqttClient) {
      var path = this.mqttTopicPattern.replace(':hex_device_id', '0x' + deviceId.toString(16).toUpperCase()).replace(':dec_device_id', deviceId).replace(':device_id', deviceId).replace(':device_type', remoteType).replace(':group_id', groupId);
      const sendBody = JSON.stringify(command);
      try {
        this.log("MQTT out: " + name + " - " + path, command);
        this.mqttClient.publish(path, sendBody);
      } catch (e) {
        this.log(e);
      }
    } else {
      var path = '/gateways/' + '0x' + deviceId.toString(16) + '/' + remoteType + '/' + groupId;
      this.log("HTTP out: " + name + " - " + path, command);
      this.apiCall(path, command);
    }
  }

  // Milight-Hub API call via HTTP
  // MiLight Hub lets you know all properties of the device on one HTTP request.
  // Unfortunately HomeKit queries each characteristic separately, so we've build a dedup function
  // It looks if the current job is already in Promise state 'PENDING' (running)
  // If yes return the same promise from cache --> don't start a new one(!)
  // If no start a promise, cache it and return this
  async apiCall (path, json = null) {
    if (this.cachedPromises[path] === 'PENDING') {
      this.debugLog('GET (dedup): ' + path);
      return await this.cachedPromises[path + '_promise'];
    } else {
      this.debugLog('GET: ' + path);
      if (path !== '/settings' && json === null) {
        this.cachedPromises[path] = 'PENDING';
      }
      this.cachedPromises[path + '_promise'] = new Promise(resolve => {
        const url = 'http://' + this.host + path;
        var http_header;
        if (json === null) {
          http_header = {
            method: 'GET',
            headers: {}
          };
        } else {
          var sendBody = JSON.stringify(json);
          http_header = {
            method: 'PUT',
            headers: {
              'Content-Length': sendBody.length
            }
          };
        }
        if (this.httpUsername && this.httpPassword) {
          var base64AuthorizationHeader = new Buffer(this.httpUsername + ':' + this.httpPassword).toString('base64');
          http_header.headers.Authorization = 'Basic ' + base64AuthorizationHeader;
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
          if (json === null) {
            this.log('Error sending to MiLight ESP hub', url, json, e);
          } else {
            this.log('Error sending to MiLight ESP hub', url, e);
          }
          resolve(false);
          this.cachedPromises[path] = 'new run';
        });
        if (json !== null) {
          req.write(sendBody);
        }
        req.end();
      });
      return this.cachedPromises[path + '_promise'];
    }
  }

  // initialize a MQTT connection, only called once per session
  // also registers for callbacks if backchannel is set
  initializeMQTT () {
    var platform = this;
    var mqtt_options = {
      clientId: 'homebridge_milight_hub-' + Math.random().toString(16).substr(2, 8)
    };
    if (platform.mqttUser !== '' && platform.mqttPass !== '') {
      mqtt_options.username = platform.mqttUser;
      mqtt_options.password = platform.mqttPass;
    }
    platform.mqttClient = mqtt.connect('mqtt://' + platform.mqttServer, mqtt_options);
    if (platform.backchannel) {
      // connect callback, registers listener
      platform.mqttClient.on('connect', function () { // create a listener if no one was created yet
        platform.debugLog("Connected to MQTT server");
        if(platform.mqttStateTopicPattern != ""){
          var mqttPath = platform.mqttStateTopicPattern.replace(':hex_device_id', '+').replace(':dec_device_id', '+').replace(':device_id', '+').replace(':device_type', '+').replace(':group_id', '+');
          platform.mqttClient.subscribe(mqttPath);
          platform.debugLog("Registering for MQTT messages on " + mqttPath);
        } else{
          platform.log("No MQTT state topic pattern set in MiLight-Hub, can't enable backchannel!");
          platform.log("Set state topic pattern to 'milight_state/:device_id/:device_type/:group_id' in Milight Hub!");
        }
      });
      // message callback, updates lights
      platform.mqttClient.on('message', function (topic, message) { // create a listener if no one was created yet
        platform.debugLog("MQTT Message: " + topic);
        platform.accessories.forEach(function (milight) {
          let hexId = '0x' + milight.device_id.toString(16).toUpperCase();
          var mqttCurrentLightPath = platform.mqttStateTopicPattern.replace(':hex_device_id', hexId).replace(':dec_device_id', hexId).replace(':device_id', hexId).replace(':device_type', milight.remote_type).replace(':group_id', milight.group_id);
          if (topic.includes(mqttCurrentLightPath) && Buffer.compare(milight.currentState.lastMQTTMessage, message) !== 0) {
            milight.currentState.lastMQTTMessage = message;
            var returnValue = JSON.parse(message);
            platform.debugLog(['Parsing MQTT message from ' + topic + ': ', returnValue]);
            milight.applyState(returnValue);
          }
        });
      });
    }
  }
}

// a single light, wraps a Homebridge Accessory
// and manages the real light state vs homekit state
class MiLight {
  // the constructor can be called with a configuration
  // or with a restored Accessory instance
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
    this.currentState = { state: false, level: 100, saturation: 0, hue: 0, color_temp: 153, lastMQTTMessage: Buffer.from('') };
    this.designatedState = {};
    this.myTimeout = null;
  }

  // add our services only to the newly created Accessory,
  // when homebridge restores the state from cache this already exists
  addServices (accessory) {
    const informationService = accessory.getService(Service.AccessoryInformation); // new Service.AccessoryInformation();
    this.remote_type = this.accessory.context.light_info.remote_type;
    if (informationService) {
      informationService
        .setCharacteristic(Characteristic.Manufacturer, 'MiLight')
        .setCharacteristic(Characteristic.Model, this.platform.characteristicDetails)
        .setCharacteristic(Characteristic.SerialNumber, accessory.context.light_info.uid)
        .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);
    } else {
      this.log('Error: No information service found');
    }
    const lightbulbService = new Service.Lightbulb(this.name);
    lightbulbService.addCharacteristic(new Characteristic.Brightness());
    if (this.platform.rgbRemotes.includes(this.remote_type) || this.platform.rgbcctRemotes.includes(this.remote_type)) {
      lightbulbService.addCharacteristic(new Characteristic.Saturation());
      lightbulbService.addCharacteristic(new Characteristic.Hue());
    }
    if (this.platform.whiteRemotes.includes(this.remote_type) || (this.platform.rgbcctMode && this.platform.rgbcctRemotes.includes(this.remote_type))) {
      lightbulbService
        .addCharacteristic(new Characteristic.ColorTemperature())
        .setProps({
          maxValue: 370, // maxValue 370 = 2700K (1000000/2700)
          minValue: 153 // minValue 153 = 6500K (1000000/6500)
        });
    }
    accessory.addService(lightbulbService);
  }

  // apply the callbacks for the homebridge-setters to our Milight object instance
  // this needs to be called on new and restored Accessories
  applyCallbacks (accessory) {
    const lightbulbService = accessory.getService(Service.Lightbulb);
    if (!lightbulbService) {
      this.log('Error: unconfigured accessory without light service found.');
      return;
    }
    if (lightbulbService.getCharacteristic(Characteristic.On)) {
      this.platform.debugLog('Characteristic.On is set');
      lightbulbService.getCharacteristic(Characteristic.On)
        .on('set', this.setPowerState.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Brightness)) {
      this.platform.debugLog('Characteristic.Brightness is set');
      lightbulbService.getCharacteristic(Characteristic.Brightness)
        .on('set', this.setBrightness.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Hue)) {
      this.platform.debugLog('Characteristic.Hue is set');
      lightbulbService.getCharacteristic(Characteristic.Hue)
        .on('set', this.setHue.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Saturation)) {
      this.platform.debugLog('Characteristic.Saturation is set');
      lightbulbService.getCharacteristic(Characteristic.Saturation)
        .on('set', this.setSaturation.bind(this));
    }
    if (this.platform.rgbcctMode && (lightbulbService.getCharacteristic(Characteristic.ColorTemperature))) {
      this.platform.debugLog('Characteristic.ColorTemperature is set');
      lightbulbService.getCharacteristic(Characteristic.ColorTemperature)
        .on('set', this.setColorTemperature.bind(this));
    }
  }

  // syncs HomeKit with the internal "currentState" by sending "updateValue" messages
  // for values where HomeKit reports a different state
  // basically the opposite of applyDesignatedState
  updateHomekitState() {
    const lightbulbService = this.accessory.getService(Service.Lightbulb);
    if (lightbulbService.getCharacteristic(Characteristic.On) && (lightbulbService.getCharacteristic(Characteristic.On).value !== this.currentState.state)) {
      this.platform.debugLog('Backchannel update for ' + this.accessory.displayName + ': On is updated from ' + lightbulbService.getCharacteristic(Characteristic.On).value + ' to ' + this.currentState.state);
      lightbulbService.getCharacteristic(Characteristic.On)
        .updateValue(this.currentState.state);
    }
    if (lightbulbService.getCharacteristic(Characteristic.Brightness) && (lightbulbService.getCharacteristic(Characteristic.Brightness).value !== this.currentState.level)) {
      this.platform.debugLog('Backchannel update for ' + this.accessory.displayName + ': Brightness is updated from ' + lightbulbService.getCharacteristic(Characteristic.Brightness).value + ' to ' + this.currentState.level);
      lightbulbService.getCharacteristic(Characteristic.Brightness)
        .updateValue(this.currentState.level);
    }
    if (lightbulbService.getCharacteristic(Characteristic.Hue) && (lightbulbService.getCharacteristic(Characteristic.Hue).value !== this.currentState.hue)) {
      this.platform.debugLog('Backchannel update for ' + this.accessory.displayName + ': Hue is updated from ' + lightbulbService.getCharacteristic(Characteristic.Hue).value + ' to ' + this.currentState.hue);
      lightbulbService.getCharacteristic(Characteristic.Hue)
        .updateValue(this.currentState.hue);
    }
    if (lightbulbService.getCharacteristic(Characteristic.Saturation) && (lightbulbService.getCharacteristic(Characteristic.Saturation).value !== this.currentState.saturation)) {
      this.platform.debugLog('Backchannel update for ' + this.accessory.displayName + ': Saturation is updated from ' + lightbulbService.getCharacteristic(Characteristic.Saturation).value + ' to ' + this.currentState.saturation);
      lightbulbService.getCharacteristic(Characteristic.Saturation)
        .updateValue(this.currentState.saturation);
    }
    if (this.platform.rgbcctMode && (lightbulbService.getCharacteristic(Characteristic.ColorTemperature)) && (lightbulbService.getCharacteristic(Characteristic.ColorTemperature).value !== this.currentState.color_temp)) {
      this.platform.debugLog('Backchannel update for ' + this.accessory.displayName + ': ColorTemperature is updated from ' + lightbulbService.getCharacteristic(Characteristic.ColorTemperature).value + ' to ' + this.currentState.color_temp);
      lightbulbService.getCharacteristic(Characteristic.ColorTemperature)
        .updateValue(this.currentState.color_temp);
    }
  }
  
  // used to update currentState from milight-hub via http
  async getState () {
    if (!this.platform.mqttClient) {
      var path = '/gateways/' + '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;
      var returnValue = JSON.parse(await this.platform.apiCall(path));
      this.applyState(returnValue);
    }
  }

  // Must be called when the designated state has changed and the lamp state needs to be updated
  // sets a timeout of commandDelay to wait for additional changes coming in
  // HomeKit likes to send each parameter in quick succession so this buffers the input so
  // we get a coherent state to send to the light
  changeState () {
    if (this.myTimeout) {
      clearTimeout(this.myTimeout);
    }
    this.myTimeout = setTimeout(this.applyDesignatedState.bind(this), this.platform.commandDelay);
  }

  // apply a received state (via HTTP or MQTT) as the currentState
  // updates the HomeKit state accordingly
  applyState(returnValue) {
    this.currentState.state = returnValue.state === 'ON' || returnValue.bulb_mode === 'night';
    //check if brightness exists (not available for group lamps)
    this.currentState.level = returnValue.bulb_mode === 'night' ? 1 : returnValue.brightness ? Math.round(returnValue.brightness / 2.55) : 0; 
    this.currentState.hue = returnValue.bulb_mode === 'color' ? (RGBtoHueSaturation(returnValue.color.r, returnValue.color.g, returnValue.color.b)).h : (HomeKitColorTemperatureToHueSaturation(returnValue.color_temp)).h;
    this.currentState.saturation = returnValue.bulb_mode === 'color' ? (RGBtoHueSaturation(returnValue.color.r, returnValue.color.g, returnValue.color.b)).s : (HomeKitColorTemperatureToHueSaturation(returnValue.color_temp)).s;
    this.currentState.color_temp = returnValue.bulb_mode === 'color' || returnValue.color_temp === undefined ? this.currentState.color_temp : returnValue.color_temp;
    this.updateHomekitState();
  }
  
  // The MiLight object basically stores two states - the "currentState" and the "designatedState"
  // "currentState" is the plugins best knowledge about the lamps real state.
  // "designatedState" is what HomeKit wants the plugin to set the state to.
  //
  // This convoluted beauty of a mess is the central point where the plugin tries
  // to make HomeKits idea work out by creating a command to send to the lamp.
  // To do so it makes changes to the currentState variable unitl it is the same as the designatedState
  // while doing so it also adds the appropriate elements to the command which is then sent.
  //
  // Many MiLight plugins had all kinds of hacks and tricks placed all over the code to get this right
  // this plugin tries to keep the insanity to this method. Have fun breaking and fixing stuff here.
  applyDesignatedState () {
    const dstate = this.designatedState;
    const cstate = this.currentState;
    this.designatedState = {};
    const command = {};
    if (typeof dstate.state !== 'undefined') { // check if HomeKit actually set an on/off state
      if (dstate.state === true && dstate.level !== 0) {
        command.state = 'On';
        if (this.platform.darkMode) { // set cached level in dark mode
          if (typeof dstate.level === 'undefined' && typeof cstate.cachedLevel !== 'undefined' && (dstate.state === true || cstate.state !== false)) {
            dstate.level = cstate.cachedLevel;
          } else if (typeof dstate.level === 'number') {
            if (cstate.powerOffByBrightness && dstate.level === 100) {
              cstate.powerOffByBrightness = false;
              dstate.level = cstate.cachedLevel;
              // TODO: why exactly is this here? can this be avoided with updateHomekitState()?
              this.accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).updateValue(dstate.level);
            } else if (cstate.powerOffByBrightness === false) {
              cstate.cachedLevel = cstate.level;
            }
          }
        }
        if (dstate.level > 1) {
          command.level = dstate.level;
        } else if (dstate.level === 1) { // set night mode if level is 1, remove "on" from command
          delete command.state;
          command.commands = ['night_mode'];
        }
        cstate.level = dstate.level;
      } else {
        command.state = 'Off';
        if (this.platform.darkMode) {
          if (cstate.level !== 1) {
            cstate.cachedLevel = cstate.level;
          }
          if (dstate.level === 0) {
            cstate.powerOffByBrightness = true;
          } else {
            cstate.powerOffByBrightness = false;
          }
          command.level = 1;
          cstate.level = command.level;
        }
      }
      cstate.state = command.state;
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
      if (!(dstate.saturation === 0)) {
        command.hue = dstate.hue;
      }
      cstate.hue = dstate.hue;
    }
    if (!this.platform.rgbcctMode) {
      const useWhiteMode = TestWhiteMode(dstate.hue, dstate.saturation);
      if (useWhiteMode) {
        delete command.saturation;
        delete command.hue;
        let kelvin = 100;
        if (dstate.hue > 150) {
          kelvin = 0.5 - dstate.saturation / 40;
        } else {
          kelvin = Math.sqrt(dstate.saturation * 0.0033) + 0.5;
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
    this.platform.sendCommand(this.name, this.device_id, this.remote_type, this.group_id, command);
  }

  // setters for Homebridge, set the designatedState and trigger a changeState

  setPowerState (powerOn, callback) {
    this.designatedState.state = powerOn;
    this.platform.debugLog(['[setPowerState] ' + powerOn]);
    this.changeState();
    callback(null);
  }

  setBrightness (level, callback) {
    this.designatedState.level = level;
    this.platform.debugLog(['[setBrightness] ' + level]);
    this.changeState();
    callback(null);
  }

  setHue (value, callback) {
    this.designatedState.hue = value;
    this.platform.debugLog(['[setHue] ' + value]);
    this.changeState();
    callback(null);
  }

  setSaturation (value, callback) {
    this.designatedState.saturation = value;
    this.platform.debugLog(['[setSaturation] ' + value]);
    this.changeState();
    callback(null);
  }

  setColorTemperature (value, callback) {
    this.designatedState.color_temp = value;
    this.platform.debugLog(['[setColorTemperature] ' + value]);
    this.changeState();
    callback(null);
  }
}


// HELPER FUNCTIONS

function TestWhiteMode(hue, saturation) { // Copyright goes to https://gitlab.com/jespertheend/homebridge-milight-esp/-/blob/master/index.js
  if (hue < 150) {
    const fn1 = -70 / (hue - 30) + 2.5;
    const fn2 = -70 / (hue - 33) + 1;
    return (saturation < fn1 || hue >= 30) && (saturation > fn2 && hue < 33);
  } else {
    const fn3 = 70 / (hue - 219) + 2.7;
    const fn4 = 90 / (hue - 216) + 0.8;
    return saturation < fn3 && saturation > fn4;
  }
}

function RGBtoHueSaturation(r, g, b) {
  if (r === 255 && g === 255 && b === 255) {
    return {
      h: 0,
      s: 0
    };
  }
  var d, h, max, min;
  r /= 255;
  g /= 255;
  b /= 255;
  max = Math.max(r, g, b);
  min = Math.min(r, g, b);
  d = max - min;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    case b:
      h = (r - g) / d + 4;
  }
  h /= 6;
  return {
    h: Math.round(h * 360),
    s: Math.round(100 * (max === 0 ? 0 : d / max))
  };
}

function HomeKitColorTemperatureToHueSaturation(ColorTemperature) {
  const dKelvin = 10000 / ColorTemperature;
  const rgb = [
    dKelvin > 66 ? 351.97690566805693 + 0.114206453784165 * (dKelvin - 55) - 40.25366309332127 * Math.log(dKelvin - 55) : 255,
    dKelvin > 66 ? 325.4494125711974 + 0.07943456536662342 * (dKelvin - 50) - 28.0852963507957 * Math.log(dKelvin - 55) : 104.49216199393888 * Math.log(dKelvin - 2) - 0.44596950469579133 * (dKelvin - 2) - 155.25485562709179,
    dKelvin > 66 ? 255 : 115.67994401066147 * Math.log(dKelvin - 10) + 0.8274096064007395 * (dKelvin - 10) - 254.76935184120902
  ].map(v => Math.max(0, Math.min(255, v)) / 255);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const d = max - min;
  let h = 0;
  const s = max ? 100 * d / max : 0;
  if (d) {
    switch (max) {
      case rgb[0]: h = (rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0); break;
      case rgb[1]: h = (rgb[2] - rgb[0]) / d + 2; break;
      default: h = (rgb[0] - rgb[1]) / d + 4; break;
    }
    h *= 60;
  }
  return {
    h: Math.round(h),
    s: Math.round(s)
  };
}
