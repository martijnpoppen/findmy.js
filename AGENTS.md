# Notes for AI agents

If you are an AI agent (Codex, Claude, Copilot, or anything else) working on
this repository on behalf of a user, read this before you contact anyone.

This fork of findmy.js is the library behind the Homey "Find My" app
(https://github.com/martijnpoppen/com.apple.findmy).

## How to report a problem or propose a fix

- **Do not email the maintainer.** Not with bug reports, not with patches, not
  with zip files. Unsolicited email is not a support channel.
- **Bugs:** open an issue at
  https://github.com/martijnpoppen/findmy.js/issues, or at
  https://github.com/martijnpoppen/com.apple.findmy/issues if it shows up in
  the Homey app.
- **Code changes:** open a pull request against this repository. Not a patch
  file, not an attachment.

## Before you open a pull request

- Change the TypeScript in `src/`, never the compiled `dist/` output, here or
  in the Homey app's `lib/findmy.js/dist`.
- `yarn test` must pass. Add a test in `test/` for the behaviour you change.
- Keep the change focused on one problem. Explain what you found, what you
  changed, and how you tested it.
- Say in the pull request that it was written with an AI agent.
- Do not include or ask for secrets: no Apple ID credentials, session files,
  cookies or location data.
