require 'sinatra/base'  # Use the Sinatra web framework
require 'octokit'       # Use the Octokit Ruby library to interact with GitHub's REST API
require 'dotenv/load'   # Manages environment variables
require 'json'          # Allows your app to manipulate JSON data
require 'openssl'       # Verifies the webhook signature
require 'jwt'           # Authenticates a GitHub App
require 'time'          # Gets ISO 8601 representation of a Time object
require 'logger'        # Logs debug statements

# This code is a Sinatra app, for two reasons:
#   1. Because the app will require a landing page for installation.
#   2. To easily handle webhook events.

# Supported parameters for "conclusion" field of Check Run, except for "stale"
# You cannot change a check run conclusion to stale, only GitHub can set this.
# https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#create-a-check-run--parameters
CHECK_RUN_CONCLUSIONS = %w(
  action_required cancelled failure neutral success skipped timed_out
)

class GHAapp < Sinatra::Application

  # Sets the port that's used when starting the web server.
  set :port, 3000
  set :bind, '0.0.0.0'

  # Expects the private key in PEM format. Converts the newlines.
  PRIVATE_KEY = OpenSSL::PKey::RSA.new(ENV['GITHUB_PRIVATE_KEY'].gsub('\n', "\n"))

  # Your registered app must have a webhook secret.
  # The secret is used to verify that webhooks are sent by GitHub.
  WEBHOOK_SECRET = ENV['GITHUB_WEBHOOK_SECRET']

  # The GitHub App's identifier (type integer).
  APP_IDENTIFIER = ENV['GITHUB_APP_IDENTIFIER']

  # Turn on Sinatra's verbose logging during development
  configure :development do
    set :logging, Logger::DEBUG
  end

  # Executed before each request to the `/event_handler` route
  before '/event_handler' do
    get_payload_request(request)
    verify_webhook_signature

    # If a repository name is provided in the webhook, validate that
    # it consists only of latin alphabetic characters, `-`, and `_`.
    unless @payload['repository'].nil?
      halt 400 if (@payload['repository']['name'] =~ /[0-9A-Za-z\-\_]+/).nil?
    end

    authenticate_app
    # Authenticate the app installation in order to run API operations
    authenticate_installation(@payload)
  end

  post '/event_handler' do

    # Get the event type from the HTTP_X_GITHUB_EVENT header
    case request.env['HTTP_X_GITHUB_EVENT']
    when 'check_suite'
      # https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads#check_suite

      # A new check_suite has been created. Create a new check run with status queued
      if @payload['action'] == 'requested' || @payload['action'] == 'rerequested'
        create_check_run
      end

    when 'check_run'
      # https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads

      # Check that the event is being sent to this app
      if @payload['check_run']['app']['id'].to_s === APP_IDENTIFIER
        case @payload['action']
        when 'created'
          initiate_check_run
        when 'rerequested'
          create_check_run
        when 'requested_action'
          take_requested_action
        end
      end

    end

    200 # success status
  end

  helpers do

    # Create a new check run with status "queued"
    def create_check_run
      # NOTE: N+1 API calls
      CHECK_RUN_CONCLUSIONS.each {|conclusion|
        @installation_client.create_check_run(
          @payload['repository']['full_name'],
          # HACK: pass conclusion variables via title
          conclusion,
          @payload['check_run'].nil? ? @payload['check_suite']['head_sha'] : @payload['check_run']['head_sha'],
          accept: 'application/vnd.github+json'
        )
      }
    end

    def initiate_check_run
      # Once the check run is created, you'll update the status of the check run
      # to 'in_progress' and run the CI process. When the CI finishes, you'll
      # update the check run status to 'completed' and add the CI results.

      @installation_client.update_check_run(
        @payload['repository']['full_name'],
        @payload['check_run']['id'],
        status: 'in_progress',
        accept: 'application/vnd.github+json'
      )

      # ***** RUN A CI TEST *****
      sleep 3

      # Mark the check run as complete!
      @installation_client.update_check_run(
        @payload['repository']['full_name'],
        @payload['check_run']['id'],
        # HACK: pass conclusion variables via title
        conclusion: @payload['check_run']['name'],
        output: {
          title: 'Status Check result',
          summary: '**Summary** comes here.',
          text: '**Text** comes here.',
          images: [
            {
              alt: "celebrate image",
              image_url: "https://burst.shopifycdn.com/photos/sparkler-lit-and-burning.jpg?width=925&format=pjpg&exif=1&iptc=1",
              caption: "image from burst.shopify.com",
            },
            {
              alt: "coffee image",
              image_url: "https://burst.shopifycdn.com/photos/lenses-lattes.jpg?width=925&format=pjpg&exif=1&iptc=1",
              caption: "image from burst.shopify.com",
            },
          ]
        },
        actions: [
          {
            label: 'Turn on 💡',
            description: 'Turn on the flag.',
            identifier: 'turn_on',
          },
          {
            label: 'Turn off 🔕',
            description: 'Turn off the flag.',
            identifier: 'turn_off',
          },
        ],
        accept: 'application/vnd.github+json'
      )

    end

    # Handles the check run `requested_action` event
    # See /webhooks/event-payloads/#check_run
    def take_requested_action
      full_repo_name = @payload['repository']['full_name']
      repository     = @payload['repository']['name']
      head_branch    = @payload['check_run']['check_suite']['head_branch']

      identifier = @payload['requested_action']['identifier']
      if identifier == 'turn_on'
        puts "Turning on..."
      elsif identifier == 'turn_off'
        puts "Turning off..."
      end
    end


    # Saves the raw payload and converts the payload to JSON format
    def get_payload_request(request)
      # request.body is an IO or StringIO object
      # Rewind in case someone already read it
      request.body.rewind
      # The raw text of the body is required for webhook signature verification
      @payload_raw = request.body.read
      begin
        @payload = JSON.parse @payload_raw
      rescue => e
        fail  'Invalid JSON (#{e}): #{@payload_raw}'
      end
    end

    # Instantiate an Octokit client authenticated as a GitHub App.
    # GitHub App authentication requires that you construct a
    # JWT (https://jwt.io/introduction/) signed with the app's private key,
    # so GitHub can be sure that it came from the app an not altererd by
    # a malicious third party.
    def authenticate_app
      payload = {
          # The time that this JWT was issued, _i.e._ now.
          iat: Time.now.to_i,

          # JWT expiration time (10 minute maximum)
          exp: Time.now.to_i + (10 * 60),

          # Your GitHub App's identifier number
          iss: APP_IDENTIFIER
      }

      # Cryptographically sign the JWT.
      jwt = JWT.encode(payload, PRIVATE_KEY, 'RS256')

      # Create the Octokit client, using the JWT as the auth token.
      @app_client ||= Octokit::Client.new(bearer_token: jwt)
    end

    # Instantiate an Octokit client, authenticated as an installation of a
    # GitHub App, to run API operations.
    def authenticate_installation(payload)
      @installation_id = payload['installation']['id']
      @installation_token = @app_client.create_app_installation_access_token(@installation_id)[:token]
      @installation_client = Octokit::Client.new(bearer_token: @installation_token)
    end

    # Check X-Hub-Signature to confirm that this webhook was generated by
    # GitHub, and not a malicious third party.
    #
    # GitHub uses the WEBHOOK_SECRET, registered to the GitHub App, to
    # create the hash signature sent in the `X-HUB-Signature` header of each
    # webhook. This code computes the expected hash signature and compares it to
    # the signature sent in the `X-HUB-Signature` header. If they don't match,
    # this request is an attack, and you should reject it. GitHub uses the HMAC
    # hexdigest to compute the signature. The `X-HUB-Signature` looks something
    # like this: 'sha1=123456'.
    # See https://developer.github.com/webhooks/securing/ for details.
    def verify_webhook_signature
      their_signature_header = request.env['HTTP_X_HUB_SIGNATURE'] || 'sha1='
      method, their_digest = their_signature_header.split('=')
      our_digest = OpenSSL::HMAC.hexdigest(method, WEBHOOK_SECRET, @payload_raw)
      halt 401 unless their_digest == our_digest

      # The X-GITHUB-EVENT header provides the name of the event.
      # The action value indicates the which action triggered the event.
      logger.debug "---- received event #{request.env['HTTP_X_GITHUB_EVENT']}"
      logger.debug "----    action #{@payload['action']}" unless @payload['action'].nil?
    end

  end

  # Finally some logic to let us run this server directly from the command line,
  # or with Rack. Don't worry too much about this code. But, for the curious:
  # $0 is the executed file
  # __FILE__ is the current file
  # If they are the same—that is, we are running this file directly, call the
  # Sinatra run method
  run! if __FILE__ == $0
end
