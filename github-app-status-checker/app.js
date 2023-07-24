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

const database = {
  checkRunID: undefined, // TODO: adding default value
};

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

function handleGithubEventError(error) {
  if (error.response) {
    console.error(
      `Error! Status: ${error.response.status}. Message: ${error.response.data.message}`
    );
  } else {
    console.error(error);
  }
}

async function upsertCheckRunID({ octokit, payload }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const ref = payload.pull_request.head.sha; // can be a SHA, branch name, or a tag name

  // TODO: error handling
  const checkRunsResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      owner,
      repo,
      ref,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  //HACK: we don't expect more than two check runs
  const checkRuns = checkRunsResponse.data.check_runs;
  const checkRun = checkRuns[0];
  database.checkRunID = checkRun.id;
  return checkRun.id;
}

async function createCheckRun({ octokit, payload, head_sha }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  return await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: "GitHub Status Checker",
    head_sha,
    status: "queued",
    output: {
      title: "Mighty Readme report",
      summary: "Summary comes here",
      text: "Text comes here",
    },
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

async function rerequestCheckRun({ octokit, payload, check_run_id, status }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  return await octokit.request(
    "POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest",
    {
      owner,
      repo,
      check_run_id,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
}

async function updateCheckRun({ octokit, payload, check_run_id, status }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  return await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id,
      status,
      output: {
        title: "Mighty Readme report",
        summary: "Summary comes here",
        text: "Text comes here",
      },
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
}

async function updateCheckRunCompleted({ octokit, payload, check_run_id }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  return await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id,
      status: "completed",
      // Can be one of: action_required, cancelled, failure, neutral, success, skipped, stale, timed_out
      conclusion: "success", // required when completed
      output: {
        title: "Mighty Readme report",
        summary: "Summary comes here",
        text: "Text comes here",
      },
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
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
    handleGithubEventError(error);
  }
});

app.webhooks.on("pull_request.labeled", async ({ octokit, payload }) => {
  const labelName = payload.label.name;
  let checkRunID = database.check_run_id;

  try {
    if (typeof check_run_id === "undefined") {
      checkRunID = await upsertCheckRunID({ octokit, payload });
    }

    if (labelName === "in_progress") {
      await updateCheckRun({
        octokit,
        payload,
        check_run_id: checkRunID,
        status: labelName,
      });
    } else if (labelName === "queued") {
      await updateCheckRun({
        octokit,
        payload,
        check_run_id: checkRunID,
        status: labelName,
      });
    } else if (labelName === "rerequest") {
      await rerequestCheckRun({
        octokit,
        payload,
        check_run_id: checkRunID,
      });
    } else if (labelName === "create_check_run") {
      const head_sha = payload.pull_request.head.sha;
      const response = await createCheckRun({
        octokit,
        payload,
        head_sha,
      });
      database.checkRunID = response.data.id;
    } else {
      //TODO: error handling
      console.error("No label.");
    }
  } catch (error) {
    handleGithubEventError(error);
  }
});

app.webhooks.on("pull_request.unlabeled", async ({ octokit, payload }) => {
  try {
    await updateCheckRunCompleted({
      octokit,
      payload,
      check_run_id: database.checkRunID,
    });
  } catch (error) {
    handleGithubEventError(error);
  }
});

app.webhooks.on("check_suite", async ({ octokit, payload }) => {
  if (payload.action === "requested" || payload.action === "rerequested") {
    const head_sha = payload.check_suite
      ? payload.check_suite.head_sha
      : payload.check_run.head_sha;

    try {
      const response = await createCheckRun({
        octokit,
        payload,
        head_sha,
      });
      database.checkRunID = response.data.id;
    } catch (error) {
      handleGithubEventError(error);
    }
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
