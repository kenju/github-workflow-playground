# Sample GitHub App

Originally from this [Quickstart](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart) guide.

## Development

Create .env file and fill in credentials:

```
cp .env.sample .env
vim .env
```

In the first terminal, start proxying via smee.io:

```
npx smee --url YOUR_DOMAIN -t http://localhost:3000/api/webhook
```

In the second terminal, launch a local server process:

```
npm run server
```
