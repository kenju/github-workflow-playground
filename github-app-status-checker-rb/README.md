# github-app-status-checker-rb

Originally inspired by [this tutorial](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-ci-checks-with-a-github-app)

## Development

Copy .env file and fill credentials:

```
cp .env.sample .env
vim .anv
```

Install dependencies:


```
bundle install
```

In the terminal, start Smee proxy:

```
smee --url YOUR_DOMAIN --path /event_handler --port 3000
```

In another terminal, start the local server:


```
bundle exec ruby server.rb
```
