# Kitaryo Discord Bot

## Files
- `index.js` — bot code
- `package.json` — dependency/start configuration
- `runtime.txt` — Node runtime
- `data/data.json` — persistent bot data (created automatically)

## Render setup
1. Create a GitHub repository and upload the files.
2. On Render, create **New → Web Service** and connect the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable:
   - `DISCORD_TOKEN` = your Discord bot token
6. Deploy.

> For a Discord bot, a Render Background Worker is preferable if your Render plan offers it. A Web Service also works for a normal long-running Node process, but choose the service type available to your account.

## Discord Developer Portal
Enable these privileged intents:
- Server Members Intent
- Message Content Intent

Give the bot permissions for the features you use:
- View Channels
- Send Messages
- Embed Links
- Manage Messages
- Manage Roles
- Moderate Members
- Kick Members
- Ban Members
- Manage Channels
- Add Reactions

Put the bot's role ABOVE roles it needs to assign/moderate.

## Prefix
Commands accept both `s` and `S`, e.g. `s help`.

## Persistence
Configuration is saved in `data/data.json` after changes. Commit/deploy the `data` folder if you want its initial contents in GitHub. For production on Render, use a persistent disk if available on your plan, because ordinary service filesystems may be reset on redeploy/restart.

## AI mode
This build includes a lightweight local reply mode for mentions/replies and does not call an external AI API. It supports any language in the sense that it can respond to mentions, but it is not a full multilingual LLM. A real AI backend can be added later with an API key.

## Important Discord API limitation
Bulk deletion has Discord's age limitations. `purge all` loops through bulk-delete batches and can only remove messages that Discord permits bulk deletion for; it is not guaranteed to erase every historical message.

