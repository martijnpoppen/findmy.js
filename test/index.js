import { FindMy } from 'findmy.js';
import fs from 'fs';
import prompt from 'prompt';

async function main() {
  prompt.start();

  console.log('Logging in...');
  const findmy = new FindMy();

  if (fs.existsSync('authenticatedData.json')) {
    const authenticatedData = JSON.parse(fs.readFileSync('authenticatedData.json', 'utf8'));

    findmy.importAuthData(authenticatedData);
  } else {
    console.log('No authenticated data found');

    const result = await prompt.get({
      properties: {
        username: {
          description: 'Apple ID',
        },
        password: {
          description: 'Password',
          hidden: true,
        },
      },
    });

    try {
      await findmy.authenticate(result.username, result.password);
      const authData = findmy.exportAuthData();
      fs.writeFileSync('authenticatedData.json', JSON.stringify(authData, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to authenticate', error);
      return
    }
  }

  const devices = await findmy.getDevices();

  // For each device print name, battery and location
  console.log('---');
  devices.forEach((device) => {
    console.log(`Name: ${device.name}`);
    console.log(`Model: ${device.deviceDisplayName}`);
    console.log(`Battery: ${device.batteryLevel * 100}%`);
    if (device.location) {
      console.log(`Location: ${device.location.latitude}, ${device.location.longitude}`);
    } else {
      console.log('Location: Not available');
    }
    console.log('---');
  });

  const authData = findmy.exportAuthData();
  fs.writeFileSync('authenticatedData.json', JSON.stringify(authData, null, 2), 'utf8');
}

main();
