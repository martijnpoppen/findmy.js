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
      console.log(
        `Location: ${location.lat}, ${location.lon} with accuracy ${location.accuracy}`
      );
    } else {
      console.log('Location: unknown');
    }
    console.log('---');
  });
}

main();
```

## Long-running use

Every `authenticate()` call creates a new iCloud web session, and Apple emails
the account holder a login alert for each one. Anything that polls on a timer
should use `FindMySession`, which reuses a stored session instead of signing in,
tells an expired session apart from a flaky network, and paces sign-ins so a bad
connection cannot turn into a stream of alerts.

```javascript
import { FindMySession, RetryLaterError } from 'findmy.js';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

const session = new FindMySession({
  key: 'my-apple-id',
  username: 'someone@example.com',
  password: 'hunter2',
  // Where the session is kept between runs. Treat the contents as a password.
  store: {
    load: (key) => JSON.parse(readFileSync(`./${key}.json`, 'utf8')),
    save: (key, data) => writeFileSync(`./${key}.json`, JSON.stringify(data)),
    clear: (key) => unlinkSync(`./${key}.json`),
  },
});

try {
  const devices = await session.getDevices();
} catch (error) {
  if (error instanceof RetryLaterError) {
    // iCloud could not be reached, or the session was just replaced. The
    // session is still good; skip this round and try again after
    // error.nextAttemptAt. Do not sign in again here.
  } else {
    throw error;
  }
}
```

A `load` that throws is treated as "nothing stored". Without a `store` the
session still works, it just cannot survive a restart.

## Credits

Thanks to [Foxt](https://github.com/foxt) for most of the implementation of the Apple login system.
