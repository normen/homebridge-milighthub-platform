'use strict';
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

// config may be null
// api may be null if launched from old homebridge version
class MiLightHubPlatform {
  constructor (log, config, api) {
    if (!config) return;
    var platform = this;
    this.log = log;
    this.config = config;
    this.debug = config['debug'] || false;

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
        // platform.log('DidFinishLaunching');
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
    this.readHubSettings(this.host).then(response => {
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
          if (platform.mqttServer) {
            platform.log('Using MQTT server at ' + platform.mqttServer);
            platform.mqttClient = mqtt.connect('mqtt://' + platform.mqttServer);
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
        this.api.registerPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });

    this.accessories.forEach((milight, idx) => {
      var found = false;
      lightList.forEach(lightInfo => {
        if (milight.group_id === lightInfo.group_id &&
            milight.device_id === lightInfo.device_id &&
            milight.remote_type === lightInfo.remote_type &&
            milight.name === lightInfo.name) {
          // already exists
          found = true;
        }
      });
      if (!found) {
        this.log('Removing ' + milight.name + ' from Homekit');
        this.accessories.splice(idx, 1);
        this.api.unregisterPlatformAccessories('homebridge-milighthub-platform', 'MiLightHubPlatform', [milight.accessory]);
      }
    });
  }

  async readHubSettings (host) {
    // console.log("apiCall", alias, json);
    return new Promise(resolve => {
      const url = 'http://' + host + '/settings';
      const req = http.request(url, {
        method: 'GET'
      }, res => {
        let recvBody = '';
        res.on('data', chunk => {
          recvBody += chunk;
        });
        res.on('end', _ => {
          // console.log("response end, status: "+res.statusCode+" recvBody: "+recvBody);
          if (res.statusCode === 200) {
            resolve(recvBody);
          } else {
            resolve(false);
          }
        });
      });
      req.on('error', e => {
        console.log('error sending to Milight esp hub', url, e);
        resolve(false);
      });
      req.end();
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
      var path = '0x' + deviceId.toString(16) + '/' + remoteType + '/' + groupId;
      this.sendHttp(path, command);
      this.log(path, command);
    }
  }

  async sendHttp (path, json) {
    return new Promise(resolve => {
      const url = 'http://' + this.host + '/gateways/' + path;
      const sendBody = JSON.stringify(json);
      const req = http.request(url, {
        method: 'PUT',
        headers: {
          'Content-Length': sendBody.length
        }
      }, res => {
        let recvBody = '';
        res.on('data', chunk => {
          recvBody += chunk;
        });
        res.on('end', _ => {
          // console.log("response end, status: "+res.statusCode+" recvBody: "+recvBody);
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
      });
      req.on('error', e => {
        // console.log('error sending to Milight esp hub', url, json, e);
        resolve(false);
      });
      req.write(sendBody);
      req.end();
    });
  }

  async getHttp (path) {
    return new Promise(resolve => {
      const url = 'http://' + this.host + '/gateways/' + path + '?blockOnQueue=true';
      const req = http.request(url, {
        method: 'GET'
      }, res => {
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
        });
      });
      req.on('error', e => {
        // console.log('error sending to Milight esp hub', url, json, e);
        resolve(false);
      });
      req.end();
    });
  }
}

class MiLight {
  constructor (platform, accessory) {
    this.log = platform.log;
    this.platform = platform;
    if (accessory instanceof Accessory) {
      this.accessory = accessory;
    } else {
      // new accessory object
      var uuid = UUIDGen.generate(accessory.name);
      this.log('Creating new accessory for ' + accessory.name + ' [' + uuid + ']');
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
    this.myTimeout = null;
  }

  addServices (accessory) {
    const informationService = accessory.getService(Service.AccessoryInformation);// new Service.AccessoryInformation();
    if (informationService) {
      informationService
          .setCharacteristic(Characteristic.Manufacturer, 'MiLight')
          .setCharacteristic(Characteristic.Model, this.remote_type)
          .setCharacteristic(Characteristic.SerialNumber, this.device_id + '[' + this.group_id + ']');
    } else {
      this.log('Error: No information service found');
    }

    const lightbulbService = new Service.Lightbulb(this.name);
    lightbulbService.addCharacteristic(new Characteristic.Brightness());

    // TODO: check types of remotes and corresponding characteristics
    // TYPES: "rgbw" "cct" "rgb_cct" "rgb" "fut089" "fut091" "fut020"
    if (['cct', 'fut091'].indexOf(this.remote_type) === -1) {
      lightbulbService.addCharacteristic(new Characteristic.Saturation());
      lightbulbService.addCharacteristic(new Characteristic.Hue());
    }

    if (['fut089', 'cct', 'rgb_cct'].indexOf(this.remote_type) > -1) {
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
      lightbulbService.getCharacteristic(Characteristic.On)
          .on('get', this.getPowerState.bind(this))
          .on('set', this.setPowerState.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Brightness)) {
      lightbulbService.getCharacteristic(Characteristic.Brightness)
          .on('set', this.setBrightness.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Saturation)) {
      lightbulbService.getCharacteristic(Characteristic.Saturation)
          .on('set', this.setSaturation.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.Hue)) {
      lightbulbService.getCharacteristic(Characteristic.Hue)
          .on('set', this.setHue.bind(this));
    }
    if (lightbulbService.getCharacteristic(Characteristic.ColorTemperature)) {
      lightbulbService.getCharacteristic(Characteristic.ColorTemperature)
          .on('set', this.setColorTemperature.bind(this));
    }
  }

  sendCommand (command) {
    this.platform.sendCommand(this.device_id, this.remote_type, this.group_id, command);
  }

  stateChange () {
    if (this.myTimeout) {
      clearTimeout(this.myTimeout);
    }
    this.myTimeout = setTimeout(this.applyDesignatedState.bind(this), 100);
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
    if (dstate.color_temp !== undefined) {
      command.color_temp = dstate.color_temp;
      cstate.color_temp = dstate.color_temp;
    }
    this.sendCommand(command);
  }

  /** MiLight shiz */
  async getPowerState (callback) {
    if (this.mqttClient) {
      //not implemented yet so return null
      callback(null, null);
    } else {
      var path = '0x' + this.device_id.toString(16) + '/' + this.remote_type + '/' + this.group_id;
      var returnValue = JSON.parse(await this.platform.getHttp(path));

      this.platform.debugLog(['\n', 'GET Request: ' + path, 'returned JSON Object: ', returnValue]);

      callback(null, returnValue.state === 'ON' || returnValue.bulb_mode === 'night');
    }
  }

  setPowerState (powerOn, callback) {
    this.designatedState.state = powerOn;
    this.stateChange();
    callback(null);
  }

  setBrightness (level, callback) {
    this.designatedState.level = level;
    this.stateChange();
    callback(null);
  }

  setHue (value, callback, context) {
    this.designatedState.hue = value;
    this.stateChange();
    callback(null);
  }

  setSaturation (value, callback) {
    this.designatedState.saturation = value;
    this.stateChange();
    callback(null);
  }

  setColorTemperature (value, callback) {
    this.designatedState.color_temp = value;
    this.stateChange();
    callback(null);
  }
}