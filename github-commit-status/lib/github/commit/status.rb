require 'dotenv/load'
require 'octokit'

require 'github/commit/status/version'

module Github
  module Commit
    module Status
      class Error < StandardError; end
      # Your code goes here...

      class Script
        def run
          puts "Updating github commit status..."

          access_token = ENV["GITHUB_TOKEN"]
          client = ::Octokit::Client.new(access_token: access_token)

          repo = 'kenju/github-workflow-playground'
          commit = '4361929'
          sha = client.commit(repo, commit).sha
          # error / failure / pending / success
          state = 'error'
          # https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#create-a-commit-status
          options = {
            context: 'fake',
            description: 'updated from github-commit-status',
            targegt_url: "https://github.com/#{repo}/commit/#{sha}",
           }
          client.create_status(repo, sha, state, options)

          puts "Updated #{repo}'s commit status to #{state} for SHA #{sha}"
        end
      end
    end
  end
end
