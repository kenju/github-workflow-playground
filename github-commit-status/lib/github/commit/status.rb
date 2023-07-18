require "github/commit/status/version"

module Github
  module Commit
    module Status
      class Error < StandardError; end
      # Your code goes here...

      class Script
        def run
          puts "hello, world"
        end
      end
    end
  end
end
