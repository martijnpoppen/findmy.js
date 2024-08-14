import { FindMy } from './findmy.js';
import { iCloudFindMyDeviceInfo } from './types/findmy.types.js';

export class FindMyDevice {
  constructor(private findmy: FindMy, private info: iCloudFindMyDeviceInfo) {}

  getRawInfo(): iCloudFindMyDeviceInfo {
    return this.info;
  }

  async playSound(deviceId: string): Promise<void> {
    await this.findmy.sendICloudRequest('findme', '/fmipservice/client/web/playSound', {
      device: deviceId,
      subject: 'Find My iPhone Alert',
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
    });
  }

  async sendMessage(deviceId: string, subject: string, text: string): Promise<void> {
    await this.findmy.sendICloudRequest('findme', '/fmipservice/client/web/sendMessage', {
      device: deviceId,
      clientContext: {
        appVersion: '1.0',
        contextApp: 'com.icloud.web.fmf',
      },
      vibrate: true,
      userText: true,
      sound: false,
      subject,
      text,
    });
  }
}
