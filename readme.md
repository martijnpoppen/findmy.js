# findmy.js

> A simple library to access Apple's Find My network

This library allows you to access Apple's Find My network. You can log in with your Apple ID and get the location of your devices.

It works without requiring 2FA login, Find My is the only service that allows this.

## Example

```javascript
import { FindMy } from 'findmy.js';
import prompt from 'prompt';

async function main() {
  prompt.start();

  console.log('Logging in...');
  const findmy = new FindMy();

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

  await findmy.authenticate(result.username, result.password);
  const devices = await findmy.getDevices();

  // For each device print name, battery and location
  console.log('---');
  devices.forEach((device) => {
    console.log(`Name: ${device.getName()}`);
    console.log(`Model: ${device.getModel().exact}`);
    console.log(`Battery: ${device.getBattery().percentage}%`);
    const location = device.getLocation();
    if (location) {
      console.log(`Location: ${location.lat}, ${location.lon} with accuracy ${location.accuracy}`);
    } else {
      console.log('Location: unknown');
    }
    console.log('---');
  });
}

main();
```

## Credits

Thanks to [Foxt](https://github.com/foxt) for most of the implementation of the Apple login system.
