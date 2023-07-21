import dotenv from "dotenv";
import fs from "fs";
import http from "http";
import { Octokit, App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";

// Load environment variables from .env file
dotenv.config();

// Set configured values
const appId = process.env.APP_ID;
const privateKeyPath = process.env.PRIVATE_KEY_PATH;
const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const secret = process.env.WEBHOOK_SECRET;
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME;
const messageForNewPRs = fs.readFileSync("./message.md", "utf8");

// Create an authenticated Octokit client authenticated as a GitHub App
const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret,
  },
  ...(enterpriseHostname && {
    Octokit: Octokit.defaults({
      baseUrl: `https://${enterpriseHostname}/api/v3`,
    }),
  }),
});

// Optional: Get & log the authenticated app's name
const { data } = await app.octokit.request("/app");

async function postMessageForPRs({ octokit, payload }) {
  await octokit.rest.issues.createComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.pull_request.number,
    body: messageForNewPRs,
  });
}

async function updateCommitStatus({ octokit, payload }) {
  await octokit.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    sha: "5e69755d3a9f357a510d774aeab3f5e7a331cb64",
    state: "success",
    description: "The build succeeded!",
    context: "GitHub Apps!",
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

// Read more about custom logging: https://github.com/octokit/core.js#logging
app.octokit.log.debug(`Authenticated as '${data.name}'`);

// Subscribe to the "pull_request.opened" webhook event
app.webhooks.on("pull_request.opened", async ({ octokit, payload }) => {
  console.log(
    `Received a pull request opened event for #${payload.pull_request.number}`
  );
  try {
    await postMessageForPRs({ octokit, payload });
  } catch (error) {
    if (error.response) {
      console.error(
        `Error! Status: ${error.response.status}. Message: ${error.response.data.message}`
      );
    } else {
      console.error(error);
    }
  }
});

app.webhooks.on("pull_request.reopened", async ({ octokit, payload }) => {
  console.log(
    `Received a pull request reopened event for #${payload.pull_request.number}`
  );
  try {
    await postMessageForPRs({ octokit, payload });
  } catch (error) {
    if (error.response) {
      console.error(
        `Error! Status: ${error.response.status}. Message: ${error.response.data.message}`
      );
    } else {
      console.error(error);
    }
  }
});

app.webhooks.on("check_suite", async ({ octokit, payload }) => {
  console.log(`Received a check_suite`);
  if (payload.action === "requested" || payload.action === "rerequested") {
    console.log("check_suite (re)requested");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: payload.repository.owner,
      repo: payload.repository.name,
      name: "GitHub Status Checker",
      head_sha: payload.check_suite ? payload.check_suite.head_sha : payload.check_run.head_sha,
      status: "in_progress",
      output: {
        title: "Mighty Readme report",
        summary: "",
        text: "",
      },
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } else {
    console.log("check_suite completed");
  }
});

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === "AggregateError") {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`);
  } else {
    console.log(error);
  }
});

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000;
const path = "/api/webhook";
const localWebhookUrl = `http://localhost:${port}${path}`;

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path });

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`);
  console.log("Press Ctrl + C to quit.");
});
