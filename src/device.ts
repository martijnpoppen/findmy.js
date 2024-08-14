import { FindMy } from './findmy.js';
import {
  iCloudFindMyDeviceInfo,
  iCloudFindMyResponse,
} from './types/findmy.types.js';

export class FindMyDevice {
  constructor(private findmy: FindMy, private info: iCloudFindMyDeviceInfo) {}

  getRawInfo(): iCloudFindMyDeviceInfo {
    return this.info;
  }

  getName(): string {
    return this.info.name;
  }

  getModel() {
    return {
      name: this.info.modelDisplayName,
      exact: this.info.deviceModel,
    };
  }

  getBattery() {
    return {
      percentage: this.info.batteryLevel * 100,
      status: this.info.batteryStatus,
    };
  }

  getLocation() {
    if (!this.info.location) return null;
    if (this.info.location.latitude === 0 || this.info.location.longitude === 0)
      return null;
    return {
      lat: this.info.location.latitude,
      lon: this.info.location.longitude,
      alt: this.info.location.altitude,
      accuracy: this.info.location.horizontalAccuracy,
      verticalAccuracy: this.info.location.verticalAccuracy,
    };
  }

  isLocked(): boolean {
    return this.info.activationLocked;
  }

  isLost(): boolean {
    return this.info.lostModeCapable;
  }

  async playSound(): Promise<void> {
    const result = (await this.findmy.sendICloudRequest(
      'findme',
      '/fmipservice/client/web/playSound',
      {
        device: this.info.id,
        subject: 'Find My iPhone Alert',
        clientContext: {
          appVersion: '1.0',
          contextApp: 'com.icloud.web.fmf',
        },
      },
    )) as iCloudFindMyResponse;
    this.info = result.content[0] ?? this.info;
  }

  async sendMessage(
    text: string = 'Hello findmy.js',
    subject: string = 'Find My iPhone Alert',
  ): Promise<void> {
    const result = (await this.findmy.sendICloudRequest(
      'findme',
      '/fmipservice/client/web/sendMessage',
      {
        device: this.info.id,
        clientContext: {
          appVersion: '1.0',
          contextApp: 'com.icloud.web.fmf',
        },
        vibrate: true,
        userText: true,
        sound: false,
        subject,
        text,
      },
    )) as iCloudFindMyResponse;
    this.info = result.content[0] ?? this.info;
  }

  async startLostMode(message: string, phoneNumber: string) {
    const result = (await this.findmy.sendICloudRequest(
      'findme',
      '/fmipservice/client/web/lostDevice',
      {
        device: this.info.id,
        clientContext: {
          appVersion: '1.0',
          contextApp: 'com.icloud.web.fmf',
        },
        emailUpdates: true,
        lostModeEnabled: true,
        ownerNbr: phoneNumber,
        text: message,
        trackingEnabled: true,
        userText: true,
      },
    )) as iCloudFindMyResponse;
    this.info = result.content[0] ?? this.info;
  }

  async stopLostMode() {
    const result = (await this.findmy.sendICloudRequest(
      'findme',
      '/fmipservice/client/web/lostDevice',
      {
        device: this.info.id,
        clientContext: {
          appVersion: '1.0',
          contextApp: 'com.icloud.web.fmf',
        },
        lostModeEnabled: false,
        emailUpdates: false,
        trackingEnabled: false,
        userText: false,
      },
    )) as iCloudFindMyResponse;
    this.info = result.content[0] ?? this.info;
  }
}
